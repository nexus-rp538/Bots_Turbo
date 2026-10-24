import crypto from 'node:crypto';
import { Events, PermissionFlagsBits, ChannelType, AttachmentBuilder } from 'discord.js';

// Only an explicit role or the guild owner may request a season reset.
// SendMessages alone never grants administrative authority.
export function canReset(member, guild, roleIds) {
  return member.id === guild.ownerId || roleIds.some(id => member.roles.cache.has(id));
}

export function resetTargets(guild, actorId, members, channels, roles = guild.roles.cache) {
  return {
    members: [...members.values()].filter(m => !m.user.bot && m.id !== guild.ownerId && m.id !== actorId && m.kickable).map(m => m.id),
    roles: [...roles.values()].filter(r => r.id !== guild.id && !r.managed && r.editable).sort((a,b)=>b.position-a.position).map(r=>r.id),
    channels: [...channels.values()].filter(c => c && c.deletable).sort((a,b) =>
      Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory)
    ).map(c => c.id)
  };
}

export function installSeasonReset(client, {guildId, roleIds, audit}) {
  const pending = new Map();
  let running = false;
  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);
      const commands = await guild.commands.fetch();
      const data = {
        name: 'season-reset',
        description: 'معاينة تصفير سيزون NEXUS ثم تأكيد حذف الرومات والرتب وطرد الأعضاء',
        options: [{type:3,name:'confirm',description:'كود التأكيد الظاهر بعد المعاينة، صالح دقيقتين',required:false}]
      };
      const existing = commands.find(c => c.name === data.name);
      if (existing) await guild.commands.edit(existing.id,data);
      else await guild.commands.create(data);
    } catch (error) { console.error('[season-reset] Command registration failed:',error.message); }
  });
  client.on(Events.InteractionCreate, async i => {
    if (!i.isChatInputCommand() || i.commandName !== 'season-reset') return;
    try {
      if (i.guildId !== guildId) return await i.reply({content:'الأمر متاح في سيرفر NEXUS المحدد فقط.',ephemeral:true});
      await i.deferReply({ephemeral:true});
      const member = await i.guild.members.fetch(i.user.id);
      if (!canReset(member,i.guild,roleIds)) return await i.editReply('الأمر لمالك السيرفر أو الرتبة المحددة فقط.');
      if (running) return await i.editReply('تصفير السيزون شغال بالفعل.');
      const me = await i.guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.KickMembers) || !me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return await i.editReply('البوت محتاج Kick Members وManage Channels وManage Roles. ترتيب رتبته بيحدد مين يقدر يطرده.');
      }
      const confirmation = i.options.getString('confirm');
      if (!confirmation) {
        const members = await i.guild.members.fetch();
        const channels = await i.guild.channels.fetch();
        const roles = await i.guild.roles.fetch();
        const targets = resetTargets(i.guild,i.user.id,members,channels,roles);
        const token = crypto.randomBytes(4).toString('hex');
        const snapshot = {
          guildId,createdAt:new Date().toISOString(),actorId:i.user.id,
          channels:[...channels.values()].filter(Boolean).map(c => ({
            id:c.id,name:c.name,type:c.type,parentId:c.parentId,position:c.rawPosition,
            topic:c.topic,nsfw:c.nsfw,bitrate:c.bitrate,userLimit:c.userLimit,
            permissionOverwrites:c.permissionOverwrites?.cache.map(o => ({id:o.id,type:o.type,allow:o.allow.bitfield.toString(),deny:o.deny.bitfield.toString()}))
          })),
          roles:[...roles.values()].map(r => ({id:r.id,name:r.name,position:r.position,permissions:r.permissions.bitfield.toString()})),
          members:[...members.values()].map(m => ({id:m.id,roles:[...m.roles.cache.keys()]})),
          targets
        };
        const skipped = members.size-targets.members.length;
        pending.set(i.user.id,{token,expires:Date.now()+120000,targets});
        for (const [id,p] of pending) if (p.expires < Date.now()) pending.delete(id);
        await audit({action:'season_reset_preview',by:i.user.id,channels:targets.channels.length,roles:targets.roles.length,members:targets.members.length});
        return await i.editReply({
          content:`تصفير سيزون NEXUS\nهيتم حذف ${targets.channels.length} روم/كاتجوري ورسائل الرومات المحذوفة، وطرد ${targets.members.length} عضو.\nالمستثنون: ${skipped} (المالك، منفذ الأمر، البوتات، وأي عضو أعلى من صلاحية البوت).\nهيتم حذف ${targets.roles.length} رتبة قابلة للحذف. رتب البوتات و@everyone والرتب الأعلى من البوت مستثناة بقيود ديسكورد. بيانات الموقع تفضل موجودة. الملف المرفق وصف للإعدادات والأعضاء، وليس نسخة من الرسائل ولا يقدر يرجع الأعضاء تلقائيًا.\nللتنفيذ خلال دقيقتين استخدم /season-reset واكتب في confirm: ${token}\nتجاهل الكود للإلغاء. الحذف نهائي.`,
          files:[new AttachmentBuilder(Buffer.from(JSON.stringify(snapshot,null,2)),{name:'nexus-season-snapshot.json'})]
        });
      }
      const plan = pending.get(i.user.id);
      if (!plan || plan.expires < Date.now() || confirmation !== plan.token) return await i.editReply('كود غير صحيح أو انتهى. نفذ الأمر بدون confirm لمعاينة جديدة.');
      running = true;
      pending.clear();
      const result = {action:'season_reset_complete',by:i.user.id,kicked:[],deleted:[],rolesDeleted:[],failed:[]};
      try {
        // Persist the approved scope before any Discord mutation. Abort if auditing fails.
        await audit({action:'season_reset_started',by:i.user.id,targets:plan.targets});
        await i.editReply('بدأ التنفيذ. النتيجة هتتسجل في سجل الموقع، وهحاول أبعتها لك في الخاص.');
        const reason = 'NEXUS new season reset requested by '+i.user.id;
        for (const id of plan.targets.members) {
          try {
            const m = await i.guild.members.fetch(id);
            if (m.user.bot || m.id === i.guild.ownerId || m.id === i.user.id || !m.kickable) {
              result.failed.push({type:'member',id,reason:'protected_or_not_kickable'}); continue;
            }
            await m.kick(reason); result.kicked.push(id);
          } catch (e) { result.failed.push({type:'member',id,code:e.code || 'FAILED'}); }
        }
        for (const id of plan.targets.channels) {
          try {
            const c = await i.guild.channels.fetch(id);
            if (!c?.deletable) { result.failed.push({type:'channel',id,reason:'not_deletable'}); continue; }
            await c.delete(reason); result.deleted.push(id);
          } catch (e) { result.failed.push({type:'channel',id,code:e.code || 'FAILED'}); }
        }
        for (const id of plan.targets.roles) {
          try {
            const r = await i.guild.roles.fetch(id);
            if (!r || r.id === i.guild.id || r.managed || !r.editable) {
              result.failed.push({type:'role',id,reason:'not_deletable'}); continue;
            }
            await r.delete(reason); result.rolesDeleted.push(id);
          } catch (e) { result.failed.push({type:'role',id,code:e.code || 'FAILED'}); }
        }
        await audit(result);
        const content = `انتهى تصفير السيزون: طرد ${result.kicked.length}، حذف ${result.deleted.length} روم/كاتجوري، حذف ${result.rolesDeleted.length} رتبة، تعذر ${result.failed.length}. التفاصيل في الملف وسجل الموقع.`;
        await i.user.send({content,files:[new AttachmentBuilder(Buffer.from(JSON.stringify(result,null,2)),{name:'nexus-season-result.json'})]}).catch(()=>{});
        await i.editReply(content).catch(()=>{});
      } finally { running = false; }
    } catch (error) {
      console.error('[season-reset]',error.message);
      const payload = {content:'تعذر إكمال العملية. راجع سجل البوت وسجل الموقع قبل المحاولة مجددًا.',ephemeral:true};
      if (i.deferred || i.replied) await i.editReply(payload).catch(()=>{});
      else await i.reply(payload).catch(()=>{});
    }
  });
}
