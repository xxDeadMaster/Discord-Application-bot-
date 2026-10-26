import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { getSettings, getSubmission, getSubmissionByInterviewChannel, listActiveInterviews, setInterview } from '../db.js';
import { refreshCard } from './applications.js';
import { client, getGuild } from './client.js';
import { COLORS, answerFields, truncate } from './ui.js';

/** If nobody joins an interview channel within this time, it is removed. */
const UNUSED_TIMEOUT_MS = 30 * 60 * 1000;

/** channelId -> { submissionId, joined, timer } for interviews running right now. */
const active = new Map();

function armUnusedTimer(channelId) {
  const entry = active.get(channelId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => endInterview(channelId, 'expired').catch((e) => console.warn('[interview] timeout cleanup failed:', e.message)), UNUSED_TIMEOUT_MS);
}

const humans = (channel) => channel?.members?.filter((m) => !m.user.bot).size ?? 0;

function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'applicant';
}

/**
 * Opens a temporary voice channel for an application interview.
 * Returns { ok, error?, channelId?, notes[] }.
 */
export async function startInterview({ submissionId, staffId, staffTag }) {
  const sub = await getSubmission(submissionId);
  if (!sub) return { ok: false, error: 'Application not found.', notes: [] };
  if (sub.status !== 'pending') return { ok: false, error: `This application was already ${sub.status}.`, notes: [] };

  if (sub.interview_status === 'active' && sub.interview_channel_id) {
    const existing = await client.channels.fetch(sub.interview_channel_id).catch(() => null);
    if (existing) return { ok: true, channelId: existing.id, notes: ['An interview channel was already open for this application.'] };
  }

  const guild = await getGuild();
  const settings = await getSettings();
  const parent = settings.interview_category_id || settings.ticket_category_id || undefined;

  const view = [PermissionFlagsBits.ViewChannel];
  const voice = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
  const build = (allow) => {
    const list = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
      { id: sub.user_id, allow },
    ];
    if (staffId && staffId !== sub.user_id) list.push({ id: staffId, allow });
    if (settings.staff_role_id) list.push({ id: settings.staff_role_id, allow });
    return list;
  };

  const options = {
    name: truncate(`interview-${slug(sub.role_name)}-${slug(sub.user_tag)}`, 100),
    type: ChannelType.GuildVoice,
    parent,
    reason: `Interview for application #${sub.id} started by ${staffTag}`,
  };

  let channel;
  try {
    // Try to explicitly allow Connect + Speak. If the bot itself lacks those permissions,
    // Discord refuses, so fall back to view-only (members then use the server's default voice permissions).
    channel = await guild.channels.create({ ...options, permissionOverwrites: build(voice) })
      .catch((err) => (err.code === 50013 ? guild.channels.create({ ...options, permissionOverwrites: build(view) }) : Promise.reject(err)));
  } catch (err) {
    console.error('[interview] could not create channel:', err);
    return { ok: false, error: 'I could not create the interview voice channel. The bot needs Manage Channels (and Manage Roles) in that category.', notes: [] };
  }

  await setInterview(sub.id, {
    interview_status: 'active', interview_channel_id: channel.id, interview_by_tag: staffTag,
    interview_at: new Date(), interview_joined: false,
  });
  active.set(channel.id, { submissionId: sub.id, joined: false, timer: null });
  armUnusedTimer(channel.id);

  const notes = [];

  // The applicant's answers, in the voice channel's own text chat
  try {
    const { fields } = answerFields(sub.answers, { budget: 4500 });
    await channel.send({
      content: `<@${sub.user_id}>`,
      allowedMentions: { users: [sub.user_id] },
      embeds: [new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(truncate(`Interview · ${sub.role_name} application #${sub.id}`, 256))
        .setDescription(`Applicant: <@${sub.user_id}> (${sub.user_tag})\nStarted by ${staffTag}. This channel deletes itself when everyone has left.`)
        .addFields(fields)],
    });
  } catch (err) {
    notes.push('Could not post the answers in the channel chat.');
    console.warn('[interview] could not post answers:', err.message);
  }

  // Invite the applicant
  try {
    const user = await client.users.fetch(sub.user_id);
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('You have an interview!')
        .setDescription(`Staff in **${guild.name}** want to interview you about your **${sub.role_name}** application.\n\nJoin the voice channel: <#${channel.id}>`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Join interview').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guild.id}/${channel.id}`),
      )],
    });
    notes.push('Applicant invited by DM.');
  } catch {
    notes.push('Could not DM the applicant (their DMs may be closed). They can still see the channel in the server.');
  }

  await refreshCard(sub.id);
  return { ok: true, channelId: channel.id, notes };
}

/** Deletes the voice channel and records how the interview ended ('done' | 'expired'). */
export async function endInterview(channelId, status) {
  const entry = active.get(channelId);
  active.delete(channelId);
  if (entry?.timer) clearTimeout(entry.timer);
  const sub = entry ? await getSubmission(entry.submissionId) : await getSubmissionByInterviewChannel(channelId);
  if (sub && sub.interview_channel_id === channelId && sub.interview_status === 'active') {
    await setInterview(sub.id, { interview_status: status });
    await refreshCard(sub.id);
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel) await channel.delete(status === 'expired' ? 'Interview unused' : 'Interview finished').catch((e) => console.warn('[interview] delete failed:', e.message));
}

/** Wire to voiceStateUpdate: marks joins, and deletes the channel when the last person leaves. */
export async function handleVoiceState(oldState, newState) {
  const joined = newState.channelId && active.get(newState.channelId);
  if (joined && !newState.member?.user?.bot && !joined.joined) {
    joined.joined = true;
    if (joined.timer) clearTimeout(joined.timer);
    joined.timer = null;
    await setInterview(joined.submissionId, { interview_joined: true });
  }

  const leftId = oldState.channelId && oldState.channelId !== newState.channelId ? oldState.channelId : null;
  const left = leftId && active.get(leftId);
  if (left && left.joined) {
    const channel = oldState.channel || await client.channels.fetch(leftId).catch(() => null);
    if (humans(channel) === 0) await endInterview(leftId, 'done');
  }
}

/** Someone deleted an interview channel by hand. */
export async function handleInterviewChannelDelete(channel) {
  if (!active.has(channel.id)) return;
  await endInterview(channel.id, 'done');
}

/** After a restart: pick up interviews that were running. */
export async function loadActiveInterviews() {
  const subs = await listActiveInterviews();
  for (const sub of subs) {
    const channel = sub.interview_channel_id ? await client.channels.fetch(sub.interview_channel_id).catch(() => null) : null;
    if (!channel) {
      await setInterview(sub.id, { interview_status: sub.interview_joined ? 'done' : 'expired' });
      continue;
    }
    active.set(channel.id, { submissionId: sub.id, joined: sub.interview_joined, timer: null });
    if (humans(channel) > 0) {
      const entry = active.get(channel.id);
      entry.joined = true;
    } else if (sub.interview_joined) {
      await endInterview(channel.id, 'done');
    } else {
      armUnusedTimer(channel.id);
    }
  }
  if (subs.length) console.log(`[interview] picked up ${subs.length} running interview(s)`);
}

export const _interviewState = { active, guildId: config.guildId };
