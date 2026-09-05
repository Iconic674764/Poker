const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is required.");
}

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const MAX_TIMEOUT_MS = 2_147_000_000;
const timers = new Map();
const pendingTournaments = new Map();
const pendingWithRole = new Map();
const pendingConfigured = new Map();

const ID = {
  SETUP_BUTTON: "poker_setup_button",
  SETUP_MODAL: "poker_setup_modal",
  ROLE_SELECT: "poker_role_select:",
  CAPACITY_BUTTON: "poker_capacity_button:",
  CAPACITY_MODAL: "poker_capacity_modal:",
  CODES_BUTTON: "poker_codes_button:",
  CODES_MODAL: "poker_codes_modal:",
  CREATE_BUTTON: "poker_create_button:",
  REGISTER_BUTTON: "poker_register_button:",
  REGISTER_MODAL: "poker_register_modal:",
  PANEL_PREV: "poker_panel_prev:",
  PANEL_NEXT: "poker_panel_next:",
  PANEL_REFRESH: "poker_panel_refresh:",
};

function emptyData() {
  return { version: 1, tournaments: [], registrations: [] };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      version: 1,
      tournaments: Array.isArray(parsed.tournaments) ? parsed.tournaments : [],
      registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
    };
  } catch (error) {
    console.error("Could not read data.json:", error);
    throw error;
  }
}

function saveData(data) {
  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryFile, DATA_FILE);
}

const data = loadData();

function normalizeUrl(raw) {
  const value = raw.trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function parseDuration(raw) {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  const tokenPattern = /(\d+(?:\.\d+)?)\s*(d|h|m|s)\b/gi;
  let totalMs = 0;
  let match;

  while ((match = tokenPattern.exec(input)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier =
      unit === "d"
        ? 24 * 60 * 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : unit === "m"
            ? 60 * 1000
            : 1000;
    totalMs += amount * multiplier;
  }

  const remainder = input.replace(tokenPattern, "").replace(/[\s,]+/g, "");
  if (remainder || !Number.isFinite(totalMs) || totalMs < 60_000) return null;
  return totalMs;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function discordTimestamp(date, style = "F") {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

function buildTournamentEmbed(tournament) {
  const roleText = tournament.requiredRoleId
    ? `<@&${tournament.requiredRoleId}>`
    : "Open to Everyone";
  const closed = tournament.status !== "active";
  const endText = tournament.endsAt
    ? `${discordTimestamp(tournament.endsAt, "F")} (${discordTimestamp(tournament.endsAt, "R")})`
    : "Not set";

  return new EmbedBuilder()
    .setColor(closed ? 0x747f8d : 0x5865f2)
    .setTitle(`🃏  ${tournament.pokerName}`)
    .setDescription(
      closed
        ? "**Registration is closed. This tournament has ended.**"
        : "**A new Poker.now tournament has been announced!**\nClick **Register** below to join. Fill in your Poker username to secure your spot."
    )
    .addFields(
      { name: "<:rules:1456926146456195278>   Rules", value: `\`\`\`${tournament.rules}\`\`\``, inline: false },
      { name: "<a:Gift:1456927010264715268>   Prizes", value: `\`\`\`${tournament.prizes}\`\`\``, inline: false },
      { name: "<a:arrowNeon:1456927008167825543>   Registration closes", value: endText, inline: false },
      { name: "<a:arrowNeon:1456927008167825543>   Required Role", value: roleText, inline: true },
      { name: "<:GradientProfile:1430783792024522763>   Host", value: `<@${tournament.hostId}>`, inline: false }
    )
    .setImage("attachment://banner.png")
    .setFooter({ text: "Poker.now Tournament  •  Good luck at the tables!" })
    .setTimestamp();
}

function buildRegistrationButton(tournament) {
  const hasLimit = Number(tournament.maxEntries) > 0;
  const isFull = hasLimit && tournament.registeredCount >= tournament.maxEntries;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.REGISTER_BUTTON}${tournament.id}`)
      .setLabel(
        hasLimit
          ? `Register  (${tournament.registeredCount}/${tournament.maxEntries})`
          : `Register  (${tournament.registeredCount})`
      )
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(isFull)
  );
}

async function generateTournamentBanner(name) {
  const safeName = escapeXml(name);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#071b12"/>
          <stop offset="100%" stop-color="#2d6a4f"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="360" fill="url(#bg)"/>
      <rect x="18" y="18" width="1164" height="324" rx="22" fill="none" stroke="#ffd700" stroke-width="3" opacity=".75"/>
      <text x="600" y="105" text-anchor="middle" font-family="Georgia, serif" font-size="32" fill="#ffd700">♠  POKER.NOW TOURNAMENT  ♣</text>
      <text x="600" y="205" text-anchor="middle" font-family="Arial, sans-serif" font-size="46" font-weight="bold" fill="#ffffff">${safeName}</text>
      <text x="600" y="270" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#d9f2e3">Register now • Good luck at the tables</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function generatePlayersImage(tournament, players, requestedPage = 0) {
  const width = 1100;
  const padding = 40;
  const headerHeight = 150;
  const rowHeight = 52;
  const footerHeight = 54;
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(players.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const pageStart = page * pageSize;
  const pagePlayers = players.slice(pageStart, pageStart + pageSize);
  const tableHeight = Math.max(pagePlayers.length, 1) * rowHeight;
  const height = padding + headerHeight + 44 + tableHeight + footerHeight + padding;
  const tableTop = padding + headerHeight + 44;
  const tableWidth = width - padding * 2;

  const discordX = padding + 90;
  const pokerX = padding + 700;
  let rows = "";

  if (pagePlayers.length === 0) {
    rows = `
      <rect x="${padding}" y="${tableTop}" width="${tableWidth}" height="${rowHeight}" fill="#1b4332"/>
      <text x="${width / 2}" y="${tableTop + 33}" text-anchor="middle" font-family="Arial" font-size="18" fill="#cbd5e0">No players registered yet.</text>
    `;
  } else {
    rows = pagePlayers.map((player, index) => {
      const y = tableTop + index * rowHeight;
      const fill = index % 2 === 0 ? "#1b4332" : "#163a2b";
      return `
        <rect x="${padding}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${fill}"/>
        <line x1="${padding}" y1="${y + rowHeight}" x2="${width - padding}" y2="${y + rowHeight}" stroke="#2a5c42"/>
        <text x="${padding + 24}" y="${y + 34}" font-family="monospace" font-size="17" fill="#b8860b">${String(pageStart + index + 1).padStart(2, "0")}</text>
        <text x="${discordX}" y="${y + 32}" font-family="Arial" font-size="17" fill="#ffffff">${escapeXml(`${player.discordDisplayName}  @${player.discordUsername}`)}</text>
        <text x="${pokerX}" y="${y + 32}" font-family="monospace" font-size="17" font-weight="bold" fill="#ffd700">${escapeXml(player.pokerName)}</text>
      `;
    }).join("");
  }

  const now = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="panelBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#132a1e"/>
          <stop offset="100%" stop-color="#0a1f15"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" rx="18" fill="url(#panelBg)"/>
      <rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="17" fill="none" stroke="#ffd700" stroke-width="2" opacity=".7"/>
      <text x="${width / 2}" y="${padding + 45}" text-anchor="middle" font-family="Georgia, serif" font-size="31" font-weight="bold" fill="#ffd700">🏆  ${escapeXml(tournament.pokerName)}</text>
      <text x="${width / 2}" y="${padding + 84}" text-anchor="middle" font-family="Arial" font-size="16" fill="#cbd5e0">Host: ${escapeXml(tournament.hostName)}  •  ${players.length} Players  •  Page ${page + 1}/${pageCount}</text>
      <line x1="${padding}" y1="${padding + 112}" x2="${width - padding}" y2="${padding + 112}" stroke="#ffd700" opacity=".7"/>
      <rect x="${padding}" y="${padding + 126}" width="${tableWidth}" height="44" rx="5" fill="#2d6a4f"/>
      <text x="${padding + 24}" y="${padding + 155}" font-family="Arial" font-size="15" font-weight="bold" fill="#ffd700">#</text>
      <text x="${discordX}" y="${padding + 155}" font-family="Arial" font-size="15" font-weight="bold" fill="#ffd700">DISCORD</text>
      <text x="${pokerX}" y="${padding + 155}" font-family="Arial" font-size="15" font-weight="bold" fill="#ffd700">POKER NAME</text>
      ${rows}
      <rect x="${padding}" y="${tableTop}" width="${tableWidth}" height="${tableHeight}" fill="none" stroke="#ffd700" opacity=".35"/>
      <text x="${width / 2}" y="${height - padding - 12}" text-anchor="middle" font-family="Arial" font-size="13" fill="#cbd5e0">Updated: ${escapeXml(now)}  •  Cwallet Poker Bot</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function playersFor(tournamentId) {
  return data.registrations
    .filter((registration) => registration.tournamentId === tournamentId)
    .sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt));
}

async function updateAnnouncement(client, tournament, components) {
  if (!tournament.channelId || !tournament.messageId) return;
  try {
    const channel = await client.channels.fetch(tournament.channelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(tournament.messageId);
    await message.edit({
      embeds: [buildTournamentEmbed(tournament)],
      components,
    });
  } catch (error) {
    console.warn(`Could not update announcement ${tournament.id}:`, error.message);
  }
}

async function expireTournament(client, tournament) {
  if (tournament.status !== "active") return;
  tournament.status = "completed";
  saveData(data);
  timers.delete(tournament.id);
  await updateAnnouncement(client, tournament, []);
}

function scheduleExpiry(client, tournament) {
  if (!tournament.endsAt || tournament.status !== "active") return;

  const oldTimer = timers.get(tournament.id);
  if (oldTimer) clearTimeout(oldTimer);

  const remaining = new Date(tournament.endsAt).getTime() - Date.now();
  const wait = Math.max(0, Math.min(remaining, MAX_TIMEOUT_MS));
  const timer = setTimeout(() => {
    if (remaining > MAX_TIMEOUT_MS) {
      scheduleExpiry(client, tournament);
    } else {
      expireTournament(client, tournament).catch((error) =>
        console.error(`Could not expire tournament ${tournament.id}:`, error)
      );
    }
  }, wait);
  timer.unref?.();
  timers.set(tournament.id, timer);
}

async function activeTournamentFor(guildId, client) {
  const tournament = data.tournaments
    .filter((item) => item.guildId === guildId && item.status === "active")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (!tournament) return null;
  if (tournament.endsAt && new Date(tournament.endsAt).getTime() <= Date.now()) {
    await expireTournament(client, tournament);
    return null;
  }
  return tournament;
}

function setupModal() {
  const modal = new ModalBuilder()
    .setCustomId(ID.SETUP_MODAL)
    .setTitle("🃏 Create Poker Tournament");

  const input = (id, label, style, placeholder, maxLength) =>
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setPlaceholder(placeholder)
      .setRequired(true)
      .setMaxLength(maxLength);

  modal.addComponents(
    new ActionRowBuilder().addComponents(input("t_name", "Tournament Name", TextInputStyle.Short, "Sunday Showdown Pro", 80)),
    new ActionRowBuilder().addComponents(input("t_link", "Poker.now Link", TextInputStyle.Short, "poker.now/g/abc123", 200)),
    new ActionRowBuilder().addComponents(input("t_rules", "Tournament Rules", TextInputStyle.Paragraph, "1. No multi-account\n2. Starting chips: 10,000", 1000)),
    new ActionRowBuilder().addComponents(input("t_prizes", "Prize Structure", TextInputStyle.Paragraph, "1st: 500$\n2nd: 300$", 500)),
    new ActionRowBuilder().addComponents(input("t_duration", "Registration Duration", TextInputStyle.Short, "2h 10m, 1d, 5h 30m", 40))
  );
  return modal;
}

async function handleSetupModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const rawDuration = interaction.fields.getTextInputValue("t_duration");
  const durationMs = parseDuration(rawDuration);
  if (!durationMs) {
    await interaction.editReply("❌ Invalid duration. Use `2h 10m`, `1d`, `5h`, or `30m`.");
    return;
  }

  const pendingId = crypto.randomUUID();
  pendingTournaments.set(pendingId, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    name: interaction.fields.getTextInputValue("t_name").trim(),
    pokerLink: normalizeUrl(interaction.fields.getTextInputValue("t_link")),
    rules: interaction.fields.getTextInputValue("t_rules").trim(),
    prizes: interaction.fields.getTextInputValue("t_prizes").trim(),
    durationMs,
  });

  const roles = [...(await interaction.guild.roles.fetch()).values()]
    .filter((role) => !role.managed && role.name !== "@everyone")
    .sort((a, b) => b.position - a.position)
    .slice(0, 24);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ID.ROLE_SELECT}${pendingId}`)
    .setPlaceholder("Pick a required role…")
    .addOptions([
      new StringSelectMenuOptionBuilder()
        .setLabel("Open to Everyone")
        .setValue("none")
        .setDescription("No role restriction"),
      ...roles.map((role) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(role.name)
          .setValue(role.id)
          .setDescription(`Required role: ${role.name}`)
      ),
    ]);

  await interaction.editReply({
    content: "**Step 2 — Choose the required role:**",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function handleRoleSelect(interaction, pendingId) {
  await interaction.deferUpdate();
  const pending = pendingTournaments.get(pendingId);
  pendingTournaments.delete(pendingId);

  if (!pending || !interaction.guild) {
    await interaction.editReply({ content: "❌ Session expired. Run `!poker` again.", components: [] });
    return;
  }

  pendingWithRole.set(pendingId, {
    ...pending,
    requiredRoleId: interaction.values[0] === "none" ? null : interaction.values[0],
  });

  await interaction.editReply({
    content:
      `Role selected: ${interaction.values[0] === "none" ? "Open to Everyone" : `<@&${interaction.values[0]}>`}\n\n` +
      "**Step 3 — Set the maximum number of entries:**",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ID.CAPACITY_BUTTON}${pendingId}`)
          .setLabel("Set Maximum Entries")
          .setEmoji("👥")
          .setStyle(ButtonStyle.Primary)
      ),
    ],
  });
}

async function handleCapacityButton(interaction, pendingId) {
  const modal = new ModalBuilder()
    .setCustomId(`${ID.CAPACITY_MODAL}${pendingId}`)
    .setTitle("Set Maximum Entries");
  const entriesInput = new TextInputBuilder()
    .setCustomId("max_entries")
    .setLabel("Maximum entries")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g. 50, 300, 1000")
    .setRequired(true)
    .setMaxLength(7);
  modal.addComponents(new ActionRowBuilder().addComponents(entriesInput));
  await interaction.showModal(modal);
}

async function handleCapacityModal(interaction, pendingId) {
  await interaction.deferReply({ ephemeral: true });
  const pending = pendingWithRole.get(pendingId);
  const maxEntries = Number(interaction.fields.getTextInputValue("max_entries").trim());

  if (!pending || !interaction.guild) {
    await interaction.editReply("❌ Session expired. Run `!poker` again.");
    return;
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) {
    await interaction.editReply(
      "❌ Invalid entry limit. Enter a whole number between 1 and 1,000,000."
    );
    return;
  }

  pendingWithRole.delete(pendingId);
  pendingConfigured.set(pendingId, {
    ...pending,
    maxEntries,
    codes: [],
  });
  await interaction.editReply({
    content:
      `Maximum entries: **${maxEntries}**\n\n` +
      "**Step 4 — Optional:** Add codes, or create the tournament now.",
    components: buildFinalSetupComponents(pendingId),
  });
}

function buildFinalSetupComponents(pendingId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ID.CODES_BUTTON}${pendingId}`)
        .setLabel("Add Codes")
        .setEmoji("🔐")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${ID.CREATE_BUTTON}${pendingId}`)
        .setLabel("Create Tournament")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

async function handleCodesButton(interaction, pendingId) {
  const modal = new ModalBuilder()
    .setCustomId(`${ID.CODES_MODAL}${pendingId}`)
    .setTitle("Add Tournament Codes");
  const codesInput = new TextInputBuilder()
    .setCustomId("code_list")
    .setLabel("One code per line")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("CODE-001\nCODE-002\nCODE-003")
    .setRequired(true)
    .setMaxLength(4000);
  modal.addComponents(new ActionRowBuilder().addComponents(codesInput));
  await interaction.showModal(modal);
}

async function handleCodesModal(interaction, pendingId) {
  await interaction.deferReply({ ephemeral: true });
  const pending = pendingConfigured.get(pendingId);
  if (!pending) {
    await interaction.editReply("❌ Session expired. Run `!poker` again.");
    return;
  }
  const codes = interaction.fields
    .getTextInputValue("code_list")
    .split(/\r?\n/)
    .map((code) => code.trim())
    .filter(Boolean);
  if (codes.length > pending.maxEntries) {
    await interaction.editReply(
      `❌ You provided ${codes.length} codes, but the tournament limit is ${pending.maxEntries}.`
    );
    return;
  }
  pending.codes = codes;
  await interaction.editReply({
    content:
      `✅ Saved **${codes.length}** codes. They will be assigned in join order.\n\n` +
      "You can create the tournament now.",
    components: buildFinalSetupComponents(pendingId),
  });
}

async function handleCreateTournament(interaction, pendingId, client) {
  await interaction.deferUpdate();
  const pending = pendingConfigured.get(pendingId);
  pendingConfigured.delete(pendingId);

  if (!pending || !interaction.guild) {
    await interaction.editReply({ content: "❌ Session expired. Run `!poker` again.", components: [] });
    return;
  }

  const tournament = {
    id: crypto.randomUUID(),
    guildId: pending.guildId,
    channelId: pending.channelId,
    messageId: null,
    hostId: pending.hostId,
    hostName: `<@${pending.hostId}>`,
    pokerName: pending.name,
    pokerLink: pending.pokerLink,
    rules: pending.rules,
    prizes: pending.prizes,
    requiredRoleId: pending.requiredRoleId,
    status: "active",
    registeredCount: 0,
    maxEntries: pending.maxEntries,
    codes: pending.codes,
    maxEntries,
    endsAt: new Date(Date.now() + pending.durationMs).toISOString(),
    createdAt: new Date().toISOString(),
  };

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    await interaction.editReply({ content: "❌ Channel not found.", components: [] });
    return;
  }

  const banner = new AttachmentBuilder(await generateTournamentBanner(tournament.pokerName), {
    name: "banner.png",
  });
  const announcement = await channel.send({
    content: "📢 **New Poker Tournament Announced!**",
    files: [banner],
    embeds: [buildTournamentEmbed(tournament)],
    components: [buildRegistrationButton(tournament)],
  });

  tournament.messageId = announcement.id;
  data.tournaments.push(tournament);
  saveData(data);
  scheduleExpiry(client, tournament);

  const roleName = tournament.requiredRoleId
    ? interaction.guild.roles.cache.get(tournament.requiredRoleId)?.name || tournament.requiredRoleId
    : "Open to Everyone";
  await interaction.editReply({
    content:
      `✅ **${tournament.pokerName}** announced!\n` +
      `Required role: **${roleName}**\n` +
      `Maximum entries: **${pending.maxEntries}**\n` +
      `Codes: **${pending.codes.length ? `${pending.codes.length} loaded` : "Not configured"}**`,
    components: [],
  });
}

async function handleRegisterButton(interaction, tournamentId, client) {
  const tournament = data.tournaments.find((item) => item.id === tournamentId);
  if (!tournament) {
    await interaction.reply({ content: "❌ Tournament not found.", ephemeral: true });
    return;
  }

  if (tournament.status !== "active") {
    await interaction.reply({ content: "❌ Registration is closed. This tournament has ended.", ephemeral: true });
    return;
  }
  if (tournament.endsAt && new Date(tournament.endsAt).getTime() <= Date.now()) {
    await expireTournament(client, tournament);
    await interaction.reply({ content: "❌ Registration is closed. This tournament has ended.", ephemeral: true });
    return;
  }

  if (tournament.requiredRoleId && !interaction.member.roles.cache.has(tournament.requiredRoleId)) {
    await interaction.reply({
      content: `❌ You need the <@&${tournament.requiredRoleId}> role to register.`,
      ephemeral: true,
    });
    return;
  }

  const existing = data.registrations.find(
    (registration) =>
      registration.tournamentId === tournamentId &&
      registration.discordUserId === interaction.user.id
  );
  if (existing) {
    await interaction.reply({
      content:
        `✅ You are already registered!\n\n` +
        `Poker.now username: **${existing.pokerName}**\n` +
        `<a:arrowNeon:1456927008167825543>  **Join the table here:**\n${tournament.pokerLink}`,
      ephemeral: true,
    });
    return;
  }

  if (Number(tournament.maxEntries) > 0 && tournament.registeredCount >= tournament.maxEntries) {
    await interaction.reply({
      content: `❌ Registration is full (${tournament.maxEntries} entries reached).`,
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${ID.REGISTER_MODAL}${tournamentId}`)
    .setTitle("Register for Tournament");
  const pokerName = new TextInputBuilder()
    .setCustomId("poker_name")
    .setLabel("Your Poker.now Username")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g. PokerKing99")
    .setRequired(true)
    .setMaxLength(50);
  modal.addComponents(new ActionRowBuilder().addComponents(pokerName));
  await interaction.showModal(modal);
}

async function handleRegisterModal(interaction, tournamentId, client) {
  await interaction.deferReply({ ephemeral: true });
  const tournament = data.tournaments.find((item) => item.id === tournamentId);
  if (!tournament || tournament.status !== "active") {
    await interaction.editReply("❌ Registration is closed. This tournament has ended.");
    return;
  }
  if (tournament.endsAt && new Date(tournament.endsAt).getTime() <= Date.now()) {
    await expireTournament(client, tournament);
    await interaction.editReply("❌ Registration is closed. This tournament has ended.");
    return;
  }

  if (Number(tournament.maxEntries) > 0 && tournament.registeredCount >= tournament.maxEntries) {
    await interaction.editReply(
      `❌ Registration is full (${tournament.maxEntries} entries reached).`
    );
    return;
  }

  const duplicate = data.registrations.find(
    (registration) =>
      registration.tournamentId === tournamentId &&
      registration.discordUserId === interaction.user.id
  );
  if (duplicate) {
    await interaction.editReply(
      `✅ Already registered as **${duplicate.pokerName}**.\n` +
        (duplicate.assignedCode ? `🔐 Code: **${duplicate.assignedCode}**\n` : "") +
        `🃏 ${tournament.pokerLink}`
    );
    return;
  }

  const member = interaction.member;
  const registration = {
    id: crypto.randomUUID(),
    tournamentId,
    discordUserId: interaction.user.id,
    discordDisplayName: member.displayName,
    discordUsername: interaction.user.username,
    pokerName: interaction.fields.getTextInputValue("poker_name").trim(),
    assignedCode: Array.isArray(tournament.codes)
      ? tournament.codes[tournament.registeredCount] || null
      : null,
    registeredAt: new Date().toISOString(),
  };
  data.registrations.push(registration);
  tournament.registeredCount = data.registrations.filter(
    (item) => item.tournamentId === tournamentId
  ).length;
  saveData(data);

  await updateAnnouncement(client, tournament, [buildRegistrationButton(tournament)]);
  await interaction.editReply(
    `✅ **Registered!**\n\n` +
      `Discord: **${registration.discordDisplayName}** (@${registration.discordUsername})\n` +
      `Poker Name: **${registration.pokerName}**\n` +
      (registration.assignedCode ? `🔐 Code: **${registration.assignedCode}**\n` : "") +
      `\n` +
      `🃏 **Join the table here:**\n${tournament.pokerLink}\n\n` +
      "Good luck! 🍀"
  );
}

async function buildPanel(tournament, requestedPage = 0) {
  const players = playersFor(tournament.id);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(players.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const image = await generatePlayersImage(tournament, players, page);
  return {
    files: [new AttachmentBuilder(image, { name: "current-tournament.png" })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ID.PANEL_PREV}${tournament.guildId}:${Math.max(0, page - 1)}`)
          .setLabel("Previous")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId("poker_panel_page_info")
          .setLabel(`Page ${page + 1}/${pageCount}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${ID.PANEL_NEXT}${tournament.guildId}:${Math.min(pageCount - 1, page + 1)}`)
          .setLabel("Next")
          .setEmoji("▶️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pageCount - 1)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ID.PANEL_REFRESH}${tournament.guildId}:${page}`)
          .setLabel("Refresh")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

async function handlePanelNavigation(interaction, client, page) {
  await interaction.deferUpdate();
  const tournament = await activeTournamentFor(interaction.guildId, client);
  if (!tournament) {
    await interaction.editReply({ content: "No active tournament right now.", files: [], components: [] });
    return;
  }
  const panel = await buildPanel(tournament, page);
  await interaction.editReply({ content: "", files: panel.files, components: panel.components });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`Cwallet bot ready as ${client.user.tag}`);
  for (const tournament of data.tournaments) {
    if (tournament.status === "active" && tournament.endsAt) {
      scheduleExpiry(client, tournament);
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const command = message.content.trim().toLowerCase();
  const channel = message.channel;

  if (command === "!panel") {
    await message.delete().catch(() => {});
    try {
      const tournament = await activeTournamentFor(message.guild.id, client);
      if (!tournament) {
        const sent = await channel.send("No active tournament right now. Use `!poker` to create one.");
        setTimeout(() => sent.delete().catch(() => {}), 60_000);
        return;
      }
      const panel = await buildPanel(tournament);
      const sent = await channel.send(panel);
      setTimeout(() => sent.delete().catch(() => {}), 60_000);
    } catch (error) {
      console.error("Panel error:", error);
      const sent = await channel.send("❌ Failed to load the panel. Please try again.").catch(() => null);
      if (sent) setTimeout(() => sent.delete().catch(() => {}), 60_000);
    }
    return;
  }

  if (command !== "!poker") return;
  await message.delete().catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🃏  Create a Poker Tournament")
    .setDescription(
      "Click **Setup Tournament** below to configure your poker tournament.\n" +
      "Duration examples: `2h 10m`, `1d`, `5h`, `30m`."
    )
    .addFields({
      name: "What you can set",
      value: "Tournament Name\nPoker.now Link\nRules\nPrize Structure\nRequired Role\nMaximum Entries\nRegistration Duration",
    })
    .setFooter({ text: "This setup message expires in 1 minute." });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.SETUP_BUTTON)
      .setLabel("Setup Tournament")
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Primary)
  );
  const sent = await channel.send({ embeds: [embed], components: [row] });
  setTimeout(() => sent.delete().catch(() => {}), 60_000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === ID.SETUP_BUTTON) {
        await interaction.showModal(setupModal());
      } else if (interaction.customId.startsWith(ID.REGISTER_BUTTON)) {
        await handleRegisterButton(
          interaction,
          interaction.customId.slice(ID.REGISTER_BUTTON.length),
          client
        );
      } else if (
        interaction.customId.startsWith(ID.PANEL_PREV) ||
        interaction.customId.startsWith(ID.PANEL_NEXT) ||
        interaction.customId.startsWith(ID.PANEL_REFRESH)
      ) {
        const id = interaction.customId;
        const prefix = id.startsWith(ID.PANEL_PREV)
          ? ID.PANEL_PREV
          : id.startsWith(ID.PANEL_NEXT)
            ? ID.PANEL_NEXT
            : ID.PANEL_REFRESH;
        const [, pageText] = id.slice(prefix.length).split(":");
        const page = Number.parseInt(pageText || "0", 10);
        await handlePanelNavigation(interaction, client, Number.isFinite(page) ? page : 0);
      } else if (interaction.customId.startsWith(ID.CAPACITY_BUTTON)) {
        await handleCapacityButton(
          interaction,
          interaction.customId.slice(ID.CAPACITY_BUTTON.length)
        );
      } else if (interaction.customId.startsWith(ID.CODES_BUTTON)) {
        await handleCodesButton(
          interaction,
          interaction.customId.slice(ID.CODES_BUTTON.length)
        );
      } else if (interaction.customId.startsWith(ID.CREATE_BUTTON)) {
        await handleCreateTournament(
          interaction,
          interaction.customId.slice(ID.CREATE_BUTTON.length),
          client
        );
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith(ID.ROLE_SELECT)) {
        await handleRoleSelect(
          interaction,
          interaction.customId.slice(ID.ROLE_SELECT.length),
          client
        );
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === ID.SETUP_MODAL) {
        await handleSetupModal(interaction);
      } else if (interaction.customId.startsWith(ID.CAPACITY_MODAL)) {
        await handleCapacityModal(
          interaction,
          interaction.customId.slice(ID.CAPACITY_MODAL.length)
        );
      } else if (interaction.customId.startsWith(ID.CODES_MODAL)) {
        await handleCodesModal(
          interaction,
          interaction.customId.slice(ID.CODES_MODAL.length)
        );
      } else if (interaction.customId.startsWith(ID.REGISTER_MODAL)) {
        await handleRegisterModal(
          interaction,
          interaction.customId.slice(ID.REGISTER_MODAL.length),
          client
        );
      }
    }
  } catch (error) {
    console.error("Interaction error:", error);
    const response = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response).catch(() => {});
      } else {
        await interaction.reply(response).catch(() => {});
      }
    }
  }
});

client.on("error", (error) => console.error("Discord client error:", error));
client.login(token);