import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { describeSchedule, isCategoryOpen } from '../schedule.js';
import {
  createSubmission, findLastDenied, findPendingSubmission, getCategory, getRole, getSettings, getSubmission,
  listQuestions, listRoles, reviewSubmission, setSubmissionMessage, toggleVote, voteTally,
} from '../db.js';
import { client, getGuild } from './client.js';
import { startInterview } from './interviews.js';
import { bannerAttachment } from './banner.js';
import {
  BRAND, COLORS, STATUS_LABEL, accountAge, answerFields, dashboardLink, ephemeral, footer, isStaff, notice, optionEmoji, progressBar,
  truncate, unix, withEmoji,
} from './ui.js';

/**
 * Applications in progress, keyed by user ID.
 * Kept in memory: if the bot restarts mid-application, the applicant starts again.
 */
const sessions = new Map();

function endSession(userId) {
  const s = sessions.get(userId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(userId);
  return s;
}

/** The first blocked role this member has, or null. */
function blockedRole(member, settings) {
  const blocked = settings.blocked_role_ids || [];
  const cache = member?.roles?.cache;
  if (!cache || !blocked.length) return null;
  return blocked.find((id) => cache.has(id)) || null;
}

const BLOCKED_MESSAGE = "You're not allowed to apply right now. If you think this is a mistake, open a ticket.";

function armTimer(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(async () => {
    const ended = endSession(userId);
    if (!ended) return;
    await ended.dm.send({ embeds: [notice(`Your **${ended.roleName}** application expired after ${config.dmTimeoutMinutes} minutes without a reply. Pick your role again in the server to restart.`, 'warn')] }).catch(() => {});
  }, config.dmTimeoutMinutes * 60 * 1000);
}

function questionEmbed(s) {
  return new EmbedBuilder()
    .setColor(COLORS.sky)
    .setAuthor({ name: withEmoji(s.roleEmoji, `${s.roleName} application`) })
    .setTitle(`Question ${s.index + 1} of ${s.questions.length}`)
    .setDescription(`\`${progressBar(s.index, s.questions.length)}\`\n\n${truncate(s.questions[s.index].prompt, 3800)}`)
    .setFooter(footer('💬 Reply with your answer · type cancel to stop', client));
}

function reviewMessage(s) {
  const { fields, cut } = answerFields(s.answers);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: withEmoji(s.roleEmoji, `${s.roleName} application`) })
    .setTitle('📝 Review your answers')
    .setDescription(`\`${progressBar(1, 1)}\`\nAll done! Look over your answers. Nothing is sent to staff until you press **Submit**.` + (cut ? '\n*Long answers are shortened here, but staff see them in full.*' : ''))
    .addFields(fields)
    .setFooter(footer('Almost there', client));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dm:submit').setLabel('Submit application').setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dm:restart').setLabel('Start over').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dm:cancel').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

/* ---------- Panel: category -> role ---------- */

export async function handleCategorySelect(interaction) {
  const categoryId = Number(interaction.values[0]);
  const settings = await getSettings();
  const tz = settings.timezone;
  const category = await getCategory(categoryId);
  const open = isCategoryOpen(category, tz);
  const roles = open ? (await listRoles(categoryId, { enabledOnly: true })).filter((r) => r.question_count > 0) : [];

  if (blockedRole(interaction.member, settings)) {
    await interaction.reply({ embeds: [notice(BLOCKED_MESSAGE, 'blocked')], flags: ephemeral });
  } else if (category?.enabled && !open) {
    const d = describeSchedule(category, tz);
    await interaction.reply({ embeds: [notice(`**${category.name}** is closed right now.${d.changesAt ? ` It opens <t:${unix(d.changesAt)}:F> (<t:${unix(d.changesAt)}:R>).` : ''}`, 'warn')], flags: ephemeral });
  } else if (!roles.length) {
    await interaction.reply({ embeds: [notice('Nothing is open in that category right now.', 'warn')], flags: ephemeral });
  } else {
    const select = new StringSelectMenuBuilder()
      .setCustomId('apply:role')
      .setPlaceholder('🎯 Choose a role')
      .addOptions(roles.slice(0, 25).map((r) => {
        const o = {
          label: truncate(r.name, 100),
          value: String(r.id),
          description: truncate([r.description, `${r.question_count} question${r.question_count === 1 ? '' : 's'}`].filter(Boolean).join(' · '), 100),
        };
        const e = optionEmoji(r.emoji);
        if (e) o.emoji = e;
        return o;
      }));
    const banner = bannerAttachment(category.name, BRAND, 'category.png');
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(withEmoji(category.emoji, category.name))
      .setDescription(`Which role are you applying for?\n\n${roles.slice(0, 25).map((r) => `${r.emoji || '•'} **${r.name}**${r.description ? ` · ${r.description}` : ''}`).join('\n')}`)
      .setFooter(footer('Only you can see this', client));
    if (banner) embed.setImage(banner.url);
    await interaction.reply({
      embeds: [embed],
      files: banner ? [banner.file] : [],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeral,
    });
  }

  // Clear the dropdown on the public panel so it doesn't look "stuck" on a choice
  interaction.message.edit({ components: interaction.message.components }).catch(() => {});
}

export async function handleRoleSelect(interaction) {
  await interaction.deferUpdate();
  const say = (text, components = [], kind = 'warn') => interaction.editReply({ content: '', embeds: [notice(text, kind)], files: [], attachments: [], components });

  const userId = interaction.user.id;
  const role = await getRole(Number(interaction.values[0]));
  if (!role || !role.enabled) return say('That role is not open anymore.');

  const settings = await getSettings();
  if (blockedRole(interaction.member, settings)) return say(BLOCKED_MESSAGE, [], 'blocked');
  const category = await getCategory(role.category_id);
  if (!isCategoryOpen(category, settings.timezone)) {
    const d = category ? describeSchedule(category, settings.timezone) : {};
    return say(`**${category?.name || 'That application'}** is closed right now.${d.changesAt ? ` It opens <t:${unix(d.changesAt)}:F>.` : ''}`);
  }

  if (sessions.has(userId)) return say('You already have an application going in your DMs. Finish it, or type **cancel** there first.');

  const pending = await findPendingSubmission(userId);
  if (pending) return say(`You already have a pending **${pending.role_name}** application. Wait for staff to review it before applying again.`);

  if (role.discord_role_id && interaction.member?.roles?.cache?.has(role.discord_role_id)) {
    return say(`You already have the **${role.name}** role.`);
  }

  const lastDenied = await findLastDenied(userId, role.id);
  if (lastDenied && settings.apply_cooldown_days > 0) {
    const until = new Date(new Date(lastDenied.reviewed_at).getTime() + settings.apply_cooldown_days * 86400000);
    if (until > new Date()) return say(`You can apply for **${role.name}** again <t:${unix(until)}:R>.`);
  }

  const questions = await listQuestions(role.id);
  if (!questions.length) return say('That role has no questions set up yet.');

  const session = {
    userId, roleId: role.id, roleName: role.name, categoryName: role.category_name,
    roleEmoji: role.emoji || '', questions, answers: [], index: 0, stage: 'asking', dm: null, timer: null,
  };

  try {
    session.dm = await interaction.user.createDM();
    const banner = bannerAttachment(`${role.name} Application`, role.category_name, 'role.png');
    const intro = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(withEmoji(role.emoji, `${role.name} application`))
      .setDescription(`Thanks for applying, ${interaction.user}! 👋\n\nI'll ask you **${questions.length}** question${questions.length === 1 ? '' : 's'}, one at a time. Just reply here with your answer.`)
      .addFields(
        { name: '⏱️ No rush', value: `You have ${config.dmTimeoutMinutes} minutes per answer.`, inline: true },
        { name: '✖️ Changed your mind?', value: 'Type **cancel** at any time.', inline: true },
      )
      .setFooter(footer(role.category_name, client));
    if (banner) intro.setImage(banner.url);
    await session.dm.send({ embeds: [intro], files: banner ? [banner.file] : [] });
    await session.dm.send({ embeds: [questionEmbed(session)] });
  } catch (err) {
    if (err.code === 50007) {
      return say("I couldn't send you a DM. Turn on **direct messages from server members** in your privacy settings, then pick your role again.", [], 'error');
    }
    console.error('[apply] failed to start DM:', err);
    return say('Something went wrong starting your application. Please try again.', [], 'error');
  }

  sessions.set(userId, session);
  armTimer(userId);

  const link = new ButtonBuilder().setLabel('Open DMs').setEmoji('📬').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/@me/${session.dm.id}`);
  return say(`Check your DMs! I sent you the **${withEmoji(role.emoji, role.name)}** application.`, [new ActionRowBuilder().addComponents(link)], 'success');
}

/* ---------- DM answers ---------- */

export async function handleDirectMessage(message) {
  const s = sessions.get(message.author.id);
  if (!s) return;

  const text = message.content.trim();
  if (s.stage === 'review') {
    if (text.toLowerCase() === 'cancel') {
      endSession(s.userId);
      await message.channel.send({ embeds: [notice('Application cancelled. Nothing was sent to staff.', 'info')] });
    } else {
      await message.channel.send({ embeds: [notice('Use the buttons above to **submit**, **start over** or **cancel**.', 'info')] });
    }
    return;
  }

  if (!text) {
    await message.channel.send({ embeds: [notice('Please answer in text.', 'warn')] });
    return;
  }
  if (text.toLowerCase() === 'cancel') {
    endSession(s.userId);
    await message.channel.send({ embeds: [notice('Application cancelled. Nothing was sent to staff. You can apply again from the server.', 'info')] });
    return;
  }
  if (text.length > config.maxAnswerLength) {
    await message.channel.send({ embeds: [notice(`That answer is ${text.length} characters. Please keep it under ${config.maxAnswerLength}.`, 'warn')] });
    return;
  }

  s.answers.push({ q: s.questions[s.index].prompt, a: text });
  s.index += 1;
  armTimer(s.userId);

  if (s.index < s.questions.length) {
    await message.channel.send({ embeds: [questionEmbed(s)] });
  } else {
    s.stage = 'review';
    await message.channel.send(reviewMessage(s));
  }
}

export async function handleDmButton(interaction) {
  const action = interaction.customId.split(':')[1];
  const s = sessions.get(interaction.user.id);
  if (!s || s.stage !== 'review') {
    return interaction.update({ content: '', embeds: [notice('This application is no longer active.', 'info')], components: [] });
  }

  if (action === 'cancel') {
    endSession(s.userId);
    return interaction.update({ content: '', embeds: [notice('Application cancelled. Nothing was sent to staff.', 'info')], components: [] });
  }

  if (action === 'restart') {
    s.answers = [];
    s.index = 0;
    s.stage = 'asking';
    armTimer(s.userId);
    await interaction.update({ content: '', embeds: [notice('Starting over from question 1.', 'info')], components: [] });
    return interaction.channel.send({ embeds: [questionEmbed(s)] });
  }

  // submit
  endSession(s.userId); // remove first so a double-click can't submit twice
  await interaction.update({ components: [] });

  const role = await getRole(s.roleId);
  if (!role) {
    return interaction.followUp({ embeds: [notice('That role was removed while you were applying, so the application could not be submitted.', 'error')] });
  }
  const settingsNow = await getSettings();
  if ((settingsNow.blocked_role_ids || []).length) {
    const member = await (await getGuild()).members.fetch(s.userId).catch(() => null);
    if (blockedRole(member, settingsNow)) return interaction.followUp({ embeds: [notice(BLOCKED_MESSAGE, 'blocked')] });
  }

  const sub = await createSubmission({
    userId: s.userId, userTag: interaction.user.tag, roleId: role.id, roleName: role.name,
    categoryName: role.category_name, answers: s.answers, roleEmoji: role.emoji || null,
    userAvatar: interaction.user.displayAvatarURL?.({ size: 128 }) || null,
  });

  await interaction.followUp({ embeds: [new EmbedBuilder()
    .setColor(COLORS.accepted)
    .setTitle('🚀 Application submitted!')
    .setDescription(`Thanks! Staff will review your **${withEmoji(role.emoji, role.name)}** application, and I'll DM you the result right here.`)
    .addFields({ name: '📨 Application', value: `#${sub.id}`, inline: true }, { name: '⏳ Status', value: 'Waiting for review', inline: true })
    .setFooter(footer('Good luck!', client))] });

  await postSubmission(sub, role).catch((err) => console.error('[apply] could not post submission:', err));
}

/* ---------- Staff review ---------- */

/** Builds the staff card for a submission. tally = { yes, no } from voteTally(). */
export function submissionMessage(sub, tally = { yes: 0, no: 0 }) {
  const { fields, cut } = answerFields(sub.answers, { budget: 4200 });
  const color = { pending: COLORS.pending, accepted: COLORS.accepted, denied: COLORS.denied }[sub.status] ?? COLORS.muted;
  const url = dashboardLink(`/submissions/${sub.id}`);

  const parts = [STATUS_LABEL[sub.status] || sub.status, `👍 **${tally.yes}** · 👎 **${tally.no}**`];
  if (sub.interview_status === 'active' && sub.interview_channel_id) parts.push(`🎙️ Interview live in <#${sub.interview_channel_id}>`);
  if (sub.interview_status === 'done') parts.push('🎙️ Interview held');
  if (sub.interview_status === 'expired') parts.push('🎙️ Interview missed');

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '📨 New application' })
    .setTitle(truncate(`${withEmoji(sub.role_emoji, sub.role_name)} · ${sub.category_name}`, 256))
    .setURL(url)
    .setDescription(parts.join('  ·  '))
    .addFields(
      { name: '👤 Applicant', value: `<@${sub.user_id}>\n${sub.user_tag}`, inline: true },
      { name: '📅 Account age', value: accountAge(sub.user_id), inline: true },
      { name: '⏱️ Submitted', value: `<t:${unix(sub.created_at)}:R>`, inline: true },
      ...fields,
    )
    .setFooter(footer(`Application #${sub.id}${cut ? ' · full answers on the dashboard' : ''}`, client));
  if (sub.user_avatar) embed.setThumbnail(sub.user_avatar);

  if (sub.status !== 'pending') {
    const verb = sub.status === 'accepted' ? 'Accepted' : 'Denied';
    embed.addFields({
      name: sub.status === 'accepted' ? '✅ Decision' : '❌ Decision',
      value: truncate(`${verb} by ${sub.reviewed_by ? `<@${sub.reviewed_by}>` : sub.reviewed_by_tag} <t:${unix(sub.reviewed_at)}:R>${sub.reason ? `\nReason: ${sub.reason}` : ''}`, 1024),
    });
  }

  const rows = [];
  const link = url.startsWith('https://') ? new ButtonBuilder().setLabel('Dashboard').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(url) : null;
  if (sub.status === 'pending') {
    const interviewing = sub.interview_status === 'active';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sub:vote:yes:${sub.id}`).setLabel(String(tally.yes)).setEmoji('👍').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sub:vote:no:${sub.id}`).setLabel(String(tally.no)).setEmoji('👎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sub:interview:${sub.id}`)
        .setLabel(interviewing ? 'Interview live' : sub.interview_status ? 'New interview' : 'Interview')
        .setEmoji('🎙️')
        .setStyle(ButtonStyle.Primary),
    ));
    const second = [
      new ButtonBuilder().setCustomId(`sub:accept:${sub.id}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sub:deny:${sub.id}`).setLabel('Deny').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    ];
    if (link) second.push(link);
    rows.push(new ActionRowBuilder().addComponents(second));
  } else if (link) {
    rows.push(new ActionRowBuilder().addComponents(link));
  }
  return { embeds: [embed], components: rows };
}

/** Re-renders a submission's staff card in Discord (after a vote, interview or decision). */
export async function refreshCard(submissionId) {
  const sub = await getSubmission(submissionId);
  if (!sub?.review_channel_id || !sub.review_message_id) return;
  try {
    const channel = await client.channels.fetch(sub.review_channel_id);
    const msg = await channel.messages.fetch(sub.review_message_id);
    await msg.edit(submissionMessage(sub, await voteTally(sub.id)));
  } catch (err) {
    console.warn(`[apply] could not update review message for #${sub.id}:`, err.message);
  }
}

async function postSubmission(sub, role) {
  const settings = await getSettings();
  const channelId = role.submissions_channel_id || settings.submissions_channel_id;
  if (!channelId) {
    console.warn(`[apply] submission #${sub.id} saved, but no submissions channel is set. It is still on the dashboard.`);
    return;
  }
  const channel = await client.channels.fetch(channelId);
  const msg = await channel.send(submissionMessage(sub));
  await setSubmissionMessage(sub.id, channel.id, msg.id);
}

/** Staff vote from Discord or the website. Returns { ok, error?, vote, tally }. */
export async function castVote({ submissionId, userId, userTag, vote }) {
  if (!['yes', 'no'].includes(vote)) return { ok: false, error: 'Unknown vote.' };
  const sub = await getSubmission(submissionId);
  if (!sub) return { ok: false, error: 'Application not found.' };
  if (sub.status !== 'pending') return { ok: false, error: `Voting is closed: this application was already ${sub.status}.` };
  const now = await toggleVote(submissionId, userId, userTag, vote);
  await refreshCard(submissionId);
  return { ok: true, vote: now, tally: await voteTally(submissionId) };
}

/**
 * Accepts or denies an application. Used by the Discord buttons and the website.
 * Returns { ok, error?, sub?, notes[] }.
 */
export async function decideSubmission({ submissionId, decision, reviewerId, reviewerTag, reason }) {
  if (!['accepted', 'denied'].includes(decision)) return { ok: false, error: 'Unknown decision.', notes: [] };

  const sub = await reviewSubmission(submissionId, decision, reviewerId, reviewerTag, reason);
  if (!sub) {
    const existing = await getSubmission(submissionId);
    return { ok: false, error: existing ? `Already ${existing.status} by ${existing.reviewed_by_tag || 'someone'}.` : 'Application not found.', notes: [] };
  }

  const notes = [];
  const guild = await getGuild();

  if (decision === 'accepted' && sub.role_id) {
    const role = await getRole(sub.role_id);
    if (role?.discord_role_id) {
      try {
        const member = await guild.members.fetch(sub.user_id);
        await member.roles.add(role.discord_role_id, `Application #${sub.id} accepted by ${reviewerTag}`);
        notes.push('Role given.');
      } catch (err) {
        notes.push(`Could not give the role (${err.message}). Make sure the bot's role is above it in Server Settings > Roles.`);
      }
    }
  }

  try {
    const user = await client.users.fetch(sub.user_id);
    const embed = new EmbedBuilder()
      .setColor(decision === 'accepted' ? COLORS.accepted : COLORS.denied)
      .setTitle(decision === 'accepted' ? '🎉 Application accepted!' : '📩 Application update')
      .setDescription(decision === 'accepted'
        ? `Congrats! Your **${withEmoji(sub.role_emoji, sub.role_name)}** application was accepted. Welcome to the team!`
        : `Thanks for applying for **${withEmoji(sub.role_emoji, sub.role_name)}**. Your application wasn't accepted this time, but you're welcome to try again later.`)
      .setFooter(footer(`Application #${sub.id}`, client));
    if (reason) embed.addFields({ name: '💬 Note from staff', value: truncate(reason, 1024) });
    await user.send({ embeds: [embed] });
    notes.push('Applicant notified by DM.');
  } catch {
    notes.push('Could not DM the applicant (their DMs may be closed).');
  }

  await refreshCard(sub.id);

  return { ok: true, sub, notes };
}

async function requireStaff(interaction) {
  const settings = await getSettings();
  if (isStaff(interaction.member, settings)) return true;
  await interaction.reply({ embeds: [notice('Only staff can review applications.', 'blocked')], flags: ephemeral });
  return false;
}

export async function handleReviewButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const id = parts.at(-1);
  if (!(await requireStaff(interaction))) return;

  if (action === 'vote') {
    await interaction.deferReply({ flags: ephemeral });
    const r = await castVote({ submissionId: Number(id), userId: interaction.user.id, userTag: interaction.user.tag, vote: parts[2] });
    if (!r.ok) return interaction.editReply({ embeds: [notice(r.error, 'error')] });
    return interaction.editReply({ embeds: [notice(`${r.vote ? `You voted **${r.vote === 'yes' ? '👍 yes' : '👎 no'}**.` : 'Your vote was removed.'} Votes now: 👍 ${r.tally.yes} · 👎 ${r.tally.no}`, 'success')] });
  }

  if (action === 'interview') {
    await interaction.deferReply({ flags: ephemeral });
    const r = await startInterview({ submissionId: Number(id), staffId: interaction.user.id, staffTag: interaction.user.tag });
    return interaction.editReply({ embeds: [r.ok ? notice(`Interview channel ready: <#${r.channelId}>. ${r.notes.join(' ')}`, 'success') : notice(r.error, 'error')] });
  }

  if (action === 'deny') {
    const modal = new ModalBuilder()
      .setCustomId(`sub:denymodal:${id}`)
      .setTitle(`Deny application #${id}`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Note to the applicant (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ));
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: ephemeral });
  const result = await decideSubmission({
    submissionId: Number(id), decision: 'accepted', reviewerId: interaction.user.id, reviewerTag: interaction.user.tag,
  });
  return interaction.editReply({ embeds: [result.ok ? notice(`Accepted. ${result.notes.join(' ')}`, 'success') : notice(result.error, 'error')] });
}

export async function handleDenyModal(interaction) {
  const id = Number(interaction.customId.split(':')[2]);
  if (!(await requireStaff(interaction))) return;
  await interaction.deferReply({ flags: ephemeral });
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
  const result = await decideSubmission({
    submissionId: id, decision: 'denied', reviewerId: interaction.user.id, reviewerTag: interaction.user.tag, reason,
  });
  return interaction.editReply({ embeds: [result.ok ? notice(`Denied. ${result.notes.join(' ')}`, 'success') : notice(result.error, 'error')] });
}

/** Removes the staff review cards in Discord for deleted submissions. Failures are ignored. */
export async function removeReviewMessages(rows) {
  for (const row of rows) {
    if (!row.review_channel_id || !row.review_message_id) continue;
    try {
      const channel = await client.channels.fetch(row.review_channel_id);
      const msg = await channel.messages.fetch(row.review_message_id);
      await msg.delete();
    } catch { /* already gone, or no access */ }
  }
}
