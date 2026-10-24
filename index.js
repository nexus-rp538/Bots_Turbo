import { installSeasonReset } from './season-reset.js';
import {reviewApplication, reviewState, reviewDiscordText} from './ai-review.js';
import {installMemberWelcome} from './member-welcome.js';
import { OWNER_IDS, isOwnerId, resolveFrontendUrl, BUILD_ID, SUPPORT_AUDIO_FILE } from './branding.js';
import {installSupportAnnouncements} from './support-announcements.js';
import {installCommunity,languagePayload} from './community-api.js';
import { installCreators } from './creator-api.js';
import { installStore } from './store-api.js';
// ============================================================
// NEXUS RP - WEBSITE API + DISCORD BOT
// كل كود البوت والـ Backend موجود في الملف ده فقط.
// عدّل الـ IDs هنا فقط. التوكن والـ Secrets لا تضعها هنا.
// ============================================================
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, Events, PermissionFlagsBits, ChannelType
} from 'discord.js';

const BUILD_VERSION = BUILD_ID;

// ===================== DISCORD IDs ===========================
const IDS = {
  CLIENT_ID: '1545821707976056883',
  GUILD_ID: '1522093054365012078',
  REVIEW_CHANNEL_ID: '1522093061759438927',
  PRE_ACCEPTED_ROLE_ID: '1522093054377328734',
  ENTRY_ROLE_ID: '1522093054377328735',
  VOICE_REVIEW_ROLE_ID: '1539984535582941325',
  VOICE_REJECT_ROLE_A_ID: '1530597019180339281',
  VOICE_REJECT_ROLE_B_ID: '1530597216111169586',
  OWNER_USER_ID: '1445069224899907709',

  JOB_GUILD_ID: '1535337681842606230',
  JOB_MANAGER_ROLE_ID: '1547782805495484497',
  JOB_REVIEW_EMS_CHANNEL_ID: '1554585983767285861',
  JOB_REVIEW_POLICE_CHANNEL_ID: '1554585948988112987',
  JOB_REVIEW_MECHANIC_CHANNEL_ID: '1547781785067327498',
  JOB_TICKET_EMS_CATEGORY_ID: '1535337797169320078',
  JOB_TICKET_POLICE_CATEGORY_ID: '1535338633572388977',
  JOB_TICKET_MECHANIC_CATEGORY_ID: '1535349054765142178',


  // حط كل رولات الإدارة اللي مسموح لها تراجع وتتحكم
  ADMIN_ROLE_IDS: [
    '1522093054419537959'
  ]
};

// Railway Variables المطلوبة:
// DISCORD_BOT_TOKEN       = توكن البوت
// DISCORD_CLIENT_SECRET   = Client Secret لتسجيل Discord
// SESSION_SECRET          = نص عشوائي طويل 32 حرف أو أكثر
// FRONTEND_URL            = رابط GitHub Pages كامل بدون / في الآخر
// API_PUBLIC_URL          = رابط Railway مثل https://xxxx.up.railway.app (اختياري)
// DATA_FILE               = مسار قاعدة البيانات (اختياري)
// YOUTUBE_API_KEY         = اختياري لفحص لايف YouTube
// TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET = اختياري لفحص Twitch
// ADMIN_PANEL_PASSWORD     = باسورد لوحة التحكم بالموقع

const rawPublicUrl = (process.env.API_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:3000').trim();
const API_PUBLIC_URL = (/^https?:\/\//i.test(rawPublicUrl) ? rawPublicUrl : `https://${rawPublicUrl}`).replace(/\/+$/,'');
const DISCORD_REDIRECT_URI = `${API_PUBLIC_URL}/auth/discord/callback`;


// ===================== DATABASE ==============================
// التخزين الأساسي يقدر يكون PostgreSQL خارجي عن Railway عن طريق DATABASE_URL.
// ده الأفضل لو هتنقل/تمسح مشروع Railway لأن البيانات تفضل خارج المشروع.
// لو DATABASE_URL مش موجود، النظام يرجع لملف turbo-db.json كحل احتياطي.

const file = process.env.DATA_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/turbo-db.json` : './turbo-db.json');
const seed = {
  settings:{
    applicationsOpen:true,
    jobApplicationsOpen:true,
    jobApplicationAccess:{
      ems:{open:true},
      police:{open:true},
      mechanic:{open:true,mode:'all',workshopId:''}
    },
    aboutText:'NEXUS RP هو سيرفر رول بلاي عربي بنركز فيه على السيناريوهات والتفاعل وجودة التجربة.',
    rules:[],
    news:[],
    logoImage:'',
    cityBackground:''
  },
  counters:{application:0,jobApplication:0},
  applications:[],
  jobApplications:[],
  mechanicWorkshops:[],
  creators:[],
  teamMembers:[],
  interviewSlots:[],
  panelAdmins:[],
  audit:[]
};

let queue = Promise.resolve();
let pgPool = null;
let pgReady = false;

async function getPgPool(){
  if(!process.env.DATABASE_URL) return null;
  if(pgPool) return pgPool;
  const { Pool } = await import('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized:false },
    max: 3,
    idleTimeoutMillis: 30000
  });
  return pgPool;
}

async function ensurePg(){
  const pool=await getPgPool();
  if(!pool) return null;
  if(!pgReady){
    await pool.query(`CREATE TABLE IF NOT EXISTS turbo_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    pgReady=true;
  }
  return pool;
}

async function readLocalFile(){
  try { return JSON.parse(await fs.readFile(file,'utf8')); }
  catch { return null; }
}

async function writeLocalFile(db){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(db,null,2),'utf8');
  await fs.rename(tmp,file);
}

async function readDB(){
  const pool=await ensurePg();
  if(pool){
    const result=await pool.query('SELECT data FROM turbo_state WHERE id=$1',['main']);
    if(result.rows[0]?.data) return ensureNewWebsiteFields(result.rows[0].data);
    // أول تشغيل على قاعدة خارجية: لو فيه ملف قديم على نفس السيرفر، هيتنقل تلقائيًا.
    const old=await readLocalFile();
    const initial=old || structuredClone(seed);
    await pool.query(
      `INSERT INTO turbo_state (id,data,updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
      ['main',JSON.stringify(initial)]
    );
    return ensureNewWebsiteFields(initial);
  }
  const local=await readLocalFile();
  if(local) return ensureNewWebsiteFields(local);
  const initial=structuredClone(seed);
  await writeLocalFile(initial);
  return ensureNewWebsiteFields(initial);
}

async function writeDB(db){
  const pool=await ensurePg();
  if(pool){
    await pool.query(
      `INSERT INTO turbo_state (id,data,updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
      ['main',JSON.stringify(db)]
    );
    return;
  }
  await writeLocalFile(db);
}

function mutate(fn){
  const job = queue.then(async()=>{
    const db = await readDB();
    const out = await fn(db);
    await writeDB(db);
    return out;
  });
  queue = job.catch(()=>{});
  return job;
}

function validateImportedDB(db){
  return db && typeof db==='object' && !Array.isArray(db)
    && db.settings && typeof db.settings==='object'
    && db.counters && typeof db.counters==='object'
    && Array.isArray(db.applications)
    && Array.isArray(db.creators)
    && Array.isArray(db.interviewSlots)
    && Array.isArray(db.panelAdmins)
    && Array.isArray(db.audit);
}


function ensureNewWebsiteFields(db){
  if(!db.settings || typeof db.settings!=='object') db.settings={};
  if(db.settings.nexusBrandVersion !== 4){
    db.settings.aboutText='أهلًا بيك في NEXUS. هنا بتبدأ بشخصية، وتبني مكانك بتصرفاتك وحكايتك. اقرأ القوانين، قدّم على الدخول، وخلي أول خطوة ليك محسوبة.';
    const brandUrl=resolveFrontendUrl(process.env.FRONTEND_URL);
    db.settings.logoImage=brandUrl+'/nexus-motion.webp?v=4';
    db.settings.cityBackground=brandUrl+'/nexus-banner.png?v=4';
    db.settings.nexusBrandVersion=4;
  }
  if(typeof db.settings.logoImage!=='string') db.settings.logoImage='';
  if(typeof db.settings.cityBackground!=='string') db.settings.cityBackground='';
  if(!Array.isArray(db.creatorApplications))db.creatorApplications=[];
  if(typeof db.settings.creatorApplicationsOpen!=='boolean')db.settings.creatorApplicationsOpen=true;
  if(!Array.isArray(db.teamMembers)) db.teamMembers=[];
  if(!db.counters || typeof db.counters!=='object') db.counters={application:0,jobApplication:0};
  if(typeof db.counters.jobApplication!=='number') db.counters.jobApplication=0;
  if(!Array.isArray(db.jobApplications)) db.jobApplications=[];
  if(!Array.isArray(db.settings.news)) db.settings.news=[];
  if(typeof db.settings.jobApplicationsOpen!=='boolean') db.settings.jobApplicationsOpen=true;
  if(!Array.isArray(db.mechanicWorkshops)) db.mechanicWorkshops=[];
  return db;
}

// ===================== AUTH =================================
const secret=()=>process.env.SESSION_SECRET||'dev-secret-change-me';
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function signToken(user, ttl=7*24*3600){const payload=b64({...user,exp:Math.floor(Date.now()/1000)+ttl});const sig=crypto.createHmac('sha256',secret()).update(payload).digest('base64url');return `${payload}.${sig}`}
function verifyToken(token){try{const [p,s]=String(token||'').split('.');const good=crypto.createHmac('sha256',secret()).update(p).digest('base64url');if(!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(good)))return null;const d=JSON.parse(Buffer.from(p,'base64url').toString());if(d.exp<Date.now()/1000)return null;return d}catch{return null}}
function auth(req,res,next){const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const user=verifyToken(token);if(!user)return res.status(401).json({error:'LOGIN_REQUIRED'});req.user=user;next()}
function isOwner(user){return isOwnerId(user?.id)}
function panelStaffEntry(user,db){return db?.panelAdmins?.find(a=>String(a.discordId)===String(user?.id))}
function panelStaffRole(user,db){
  if(isOwner(user))return 'owner';
  const entry=panelStaffEntry(user,db);
  if(entry)return entry.role==='manager'?'manager':'admin';
  return null;
}
function isManager(user,db){const r=panelStaffRole(user,db);return r==='owner'||r==='manager'}
function isPanelAdmin(user,db){return !!panelStaffEntry(user,db)}
function isAdmin(user,db){return !!panelStaffRole(user,db)}
async function admin(req,res,next){try{const db=await readDB();if(!isAdmin(req.user,db))return res.status(403).json({error:'ADMIN_ONLY'});req.db=db;next()}catch(e){next(e)}}
async function owner(req,res,next){if(!isOwner(req.user))return res.status(403).json({error:'OWNER_ONLY'});next()}
async function managerOrOwner(req,res,next){try{const db=req.db||await readDB();const role=panelStaffRole(req.user,db);if(role!=='owner'&&role!=='manager')return res.status(403).json({error:'MANAGER_ONLY'});req.db=db;req.staffRole=role;next()}catch(e){next(e)}}

// ===================== GEMINI REVIEW QUEUE ==================
const aiJobs = new Map();
let aiQueue = Promise.resolve();
let aiBlockedUntil = 0;
const aiRetryByUser = new Map();
function queueReview(id) {
  if(aiJobs.has(id))return aiJobs.get(id);
  const job=aiQueue.then(async()=>{
    let application, rules, canCall=false;
    await mutate(db=>{
      application=db.applications.find(a=>a.id===id);if(!application)return;
      rules=(db.settings.rules||[]).join('\n');
      const day=new Date().toISOString().slice(0,10);
      if(db.aiUsage?.day!==day)db.aiUsage={day,count:0};
      const limit=Math.min(100,Math.max(1,Number(process.env.GEMINI_DAILY_LIMIT)||20));
      if(!process.env.GEMINI_API_KEY?.trim()){application.ai=reviewState('missing_key');return;}
      if(Date.now()<aiBlockedUntil||db.aiUsage.count>=limit){application.ai=reviewState('quota','LOCAL_LIMIT');return;}
      db.aiUsage.count++;application.ai=reviewState('processing');canCall=true;
    });
    if(!application)return;
    if(canCall){
      const result=await reviewApplication(application,rules);
      if(result.status==='quota')aiBlockedUntil=Date.now()+60000;
      await mutate(db=>{const a=db.applications.find(x=>x.id===id);if(a){a.ai=result;application=a;}});
    }
    await refreshAiMessage(application);
  }).catch(()=>console.warn('[NEXUS AI] Review queue failed; saved application is available.')).finally(()=>aiJobs.delete(id));
  aiJobs.set(id,job);aiQueue=job;return job;
}

async function refreshAiMessage(application) {
    try{
      if(application.reviewMessageId&&client?.isReady()){
        const ch=await client.channels.fetch(IDS.REVIEW_CHANNEL_ID);
        const msg=await ch.messages.fetch(application.reviewMessageId);
        const embed=EmbedBuilder.from(msg.embeds[0]);
        const fields=(embed.data.fields||[]).filter(f=>f.name!=='مراجعة القصة'&&f.name!=='تقييم Gemini');
        embed.setFields(...fields,{name:'تقييم Gemini',value:reviewDiscordText(application.ai)});
        await msg.edit({embeds:[embed]});
      }
    }catch{console.warn('[NEXUS AI] Could not update review message. Review remains saved.');}
}

// ===================== DISCORD BOT ==========================

let client;

async function fetchDiscordProfile(discordId){
  const id=String(discordId||'').trim();
  if(!/^\d{16,22}$/.test(id))return {discordId:id,username:'Unknown',globalName:'Unknown',avatarUrl:'https://cdn.discordapp.com/embed/avatars/0.png'};
  try{
    if(client?.isReady()){
      const u=await client.users.fetch(id);
      return {
        discordId:id,
        username:u.username||'Unknown',
        globalName:u.globalName||u.username||'Unknown',
        avatarUrl:u.displayAvatarURL({extension:'png',size:128})
      };
    }
    const token=process.env.DISCORD_BOT_TOKEN;
    if(token){
      const r=await fetch(`https://discord.com/api/v10/users/${id}`,{headers:{Authorization:`Bot ${token}`}});
      if(r.ok){
        const x=await r.json();
        return {
          discordId:id,
          username:x.username||'Unknown',
          globalName:x.global_name||x.username||'Unknown',
          avatarUrl:x.avatar?`https://cdn.discordapp.com/avatars/${id}/${x.avatar}.png?size=128`:'https://cdn.discordapp.com/embed/avatars/0.png'
        };
      }
    }
  }catch(e){console.warn('Discord profile lookup failed:',id,e.message)}
  return {discordId:id,username:'Unknown',globalName:'Unknown',avatarUrl:'https://cdn.discordapp.com/embed/avatars/0.png'};
}

const color=0xff1616;
const adminRoleIds=()=>new Set(IDS.ADMIN_ROLE_IDS.filter(Boolean));

async function isReviewer(interaction){
  try{
    if(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if(isOwner(interaction.user)) return true;
    const db=await readDB();
    if(db.panelAdmins?.some(a=>String(a.discordId)===String(interaction.user?.id))) return true;
    const ids=adminRoleIds();
    const roles=interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
    return roles.some(id=>ids.has(id));
  }catch{return false}
}

async function dm(userId,payload){
  if(!client?.isReady()) return false;
  try{
    const u=await client.users.fetch(userId);
    let message=typeof payload==='string'?{content:payload}:payload;
    if(message?.content&&!message.embeds){message={...message,content:undefined,embeds:[new EmbedBuilder().setColor(0xff3939).setAuthor({name:'NEXUS • إشعار جديد'}).setTitle('تحديث من مدينة NEXUS').setDescription(String(message.content).slice(0,3800)).setImage(frontendUrl+'/nexus-banner.png').setFooter({text:'NEXUS • تابع التفاصيل من حسابك على الموقع'}).setTimestamp()]};}
    await community.send(u,message,userId);
    return true;
  }catch(e){
    console.warn('DM failed:',e.message);
    return false;
  }
}

function turboDmEmbed({title,description,fields=[],colorValue=color,footer='NEXUS • PLAYER SERVICES'}){
  const next=/قبولك نهائي|تصريح الدخول/.test(title)?'أهلًا بيك في المدينة. تابع دليل الدخول والقوانين من حسابك.':/رفض|لم تجتز/.test(title)?'راجع سبب القرار من الموقع. إعادة التقديم مرتبطة بالمدة الظاهرة في حسابك.':/حظر/.test(title)?'تفاصيل القرار موجودة في حسابك. تواصل مع الإدارة لو محتاج توضيح.':/مقابل/.test(title)?'راجع تفاصيل المقابلة وموعدها من حسابك، وخليك جاهز في الوقت المحدد.':'تابع حالة الطلب وأي تحديث جديد من حسابك على الموقع.';
  return new EmbedBuilder().setColor(colorValue).setAuthor({name:'NEXUS • مركز خدمات اللاعبين'})
    .setTitle(String(title).slice(0,256)).setDescription(String(description||'').slice(0,2800)+'\n\n**الخطوة الجاية**\n'+next)
    .addFields(fields.slice(0,20)).setURL(frontendUrl+'/#apply')
    .setImage(frontendUrl+'/nexus-banner.png').setFooter({text:footer}).setTimestamp();
}

async function role(userId,roleId,add=true){
  if(!roleId||!client?.isReady())return;
  try{
    const g=await client.guilds.fetch(IDS.GUILD_ID);
    const m=await g.members.fetch(userId);
    add?await m.roles.add(roleId):await m.roles.remove(roleId);
  }catch(e){console.warn('Role update failed:',e.message)}
}

async function getMemberRoles(userId){
  if(!client?.isReady()) return [];
  try{
    const g=await client.guilds.fetch(IDS.GUILD_ID);
    const m=await g.members.fetch(userId);
    return [...m.roles.cache.keys()];
  }catch{return []}
}

async function postApplication(app){
  if(!client?.isReady()||!IDS.REVIEW_CHANNEL_ID)return;
  const ch=await client.channels.fetch(IDS.REVIEW_CHANNEL_ID);
  if(!ch?.isTextBased()) throw new Error('REVIEW_CHANNEL_NOT_TEXT');
  const e=new EmbedBuilder().setColor(0xff3939).setAuthor({name:'NEXUS • مراجعة دخول المدينة'}).setTitle(`ملف تقديم #${app.number} — ${app.realName}`).setDescription(`**متقدم جديد للمدينة**\n<@${app.discordId}>\nراجع القصة والإجابات، وبعدها اختار القرار من الأزرار.`).addFields(
    {name:'العمر',value:String(app.age),inline:true},
    {name:'Discord',value:app.discordTag||app.discordId,inline:true},
    {name:'نوع الشخصية',value:({criminal:'شخصية إجرامية',police:'شرطي',mechanic:'ميكانيكي',ems:'مسعف',lawyer:'محامي',civilian:'مدني',business:'رجل أعمال'})[app.characterType]||'غير محدد',inline:true},
    {name:'قصة الشخصية',value:app.story.slice(0,1000)},
    ...app.answers.map((a,i)=>({name:`س${i+1}: ${a.q}`.slice(0,256),value:(a.a||'—').slice(0,350)})),
    {name:'تقييم Gemini',value:reviewDiscordText(app.ai)}
  ).setURL(frontendUrl+'/#admin').setFooter({text:`NEXUS • ملف التقديم ${app.number} • ${app.id}`}).setTimestamp();

  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept:${app.id}`).setLabel('قبول مبدئي').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${app.id}`).setLabel('رفض بسبب').setStyle(ButtonStyle.Danger)
  );
  const msg=await community.send(ch,{embeds:[e],components:[row]});
  await mutate(db=>{const a=db.applications.find(x=>x.id===app.id);if(a)a.reviewMessageId=msg.id});
}

async function notifyInterview(app,slot){
  const when=new Date(slot.at).toLocaleString('ar-EG',{dateStyle:'full',timeStyle:'short'});
  const embed=turboDmEmbed({
    title:'📅 تم حجز المقابلة الصوتية',
    description:'تم تثبيت موعد المقابلة الصوتية الخاصة بك في **NEXUS RP**.',
    fields:[
      {name:'رقم التقديم',value:`#${app.number}`,inline:true},
      {name:'الموعد',value:when,inline:false},
      ...(slot.note?[{name:'ملاحظات',value:String(slot.note).slice(0,1024)}]:[])
    ]
  });
  await dm(app.discordId,{embeds:[embed]});
}

async function markVoicePassed(userId,by='admin'){
  let app;
  await mutate(db=>{
    app=[...db.applications].reverse().find(a=>a.discordId===userId&&['pre_accepted','voice_review'].includes(a.status));
    if(app){
      app.status='voice_passed';
      app.voicePassedAt=Date.now();
      db.audit.push({at:Date.now(),by,action:'voice_pass',userId});
    }
  });
  if(app){
    await role(userId,IDS.PRE_ACCEPTED_ROLE_ID,false);
    await role(userId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await role(userId,IDS.VOICE_REJECT_ROLE_A_ID,false);
    await role(userId,IDS.VOICE_REJECT_ROLE_B_ID,false);
    await role(userId,IDS.ENTRY_ROLE_ID,true);
    const embed=turboDmEmbed({
      title:'✅ تم قبولك نهائيًا',
      description:'مبروك! تم اجتياز المقابلة الصوتية بنجاح وتم منحك **تصريح الدخول** إلى NEXUS RP.',
      fields:[
        {name:'الحالة',value:'مقبول نهائيًا',inline:true},
        {name:'الخطوة التالية',value:'يمكنك الآن الدخول للسيرفر وبدء تجربتك في الرول بلاي.',inline:false}
      ],
      colorValue:0x22c55e
    });
    await dm(userId,{embeds:[embed]});
  }
  return app;
}



const JOB_LABELS={ems:'مسعف',police:'شرطة',mechanic:'ميكانيكي'};
const JOB_REVIEW_CHANNELS={ems:IDS.JOB_REVIEW_EMS_CHANNEL_ID,police:IDS.JOB_REVIEW_POLICE_CHANNEL_ID,mechanic:IDS.JOB_REVIEW_MECHANIC_CHANNEL_ID};
const JOB_TICKET_CATEGORIES={ems:IDS.JOB_TICKET_EMS_CATEGORY_ID,police:IDS.JOB_TICKET_POLICE_CATEGORY_ID,mechanic:IDS.JOB_TICKET_MECHANIC_CATEGORY_ID};

async function isJobManager(interaction){
  try{
    if(isOwner(interaction.user))return true;
    const g=await client.guilds.fetch(IDS.JOB_GUILD_ID);
    const m=await g.members.fetch(interaction.user.id);
    return m.roles.cache.has(IDS.JOB_MANAGER_ROLE_ID);
  }catch{return false}
}

async function postJobApplication(job){
  if(!client?.isReady())return;
  const channelId=JOB_REVIEW_CHANNELS[job.type];
  if(!channelId)return;
  const ch=await client.channels.fetch(channelId);
  if(!ch?.isTextBased())throw new Error('JOB_REVIEW_CHANNEL_NOT_TEXT');
  const fields=[
    {name:'المتقدم',value:`<@${job.discordId}>`,inline:true},
    {name:'الاسم',value:job.realName,inline:true},
    {name:'العمر',value:String(job.age),inline:true},
    {name:'الوظيفة',value:JOB_LABELS[job.type]||job.type,inline:true},
    ...(job.type==='mechanic'?[{name:'الورشة',value:job.workshopName||'غير محددة',inline:true}]:[]),
    {name:'الخبرة',value:String(job.experience||'—').slice(0,1024)},
    {name:'ليه عايز الوظيفة؟',value:String(job.why||'—').slice(0,1024)},
    {name:'أوقات التواجد',value:String(job.availability||'—').slice(0,1024)}
  ];
  const embed=new EmbedBuilder().setColor(0xff3939).setAuthor({name:'NEXUS • إدارة الوظائف'}).setTitle(`ملف ${JOB_LABELS[job.type]} • طلب #${job.number}`).setDescription('**طلب انضمام جديد**\nراجع بيانات وخبرة المتقدم قبل القبول وفتح تذكرة الاستكمال.').addFields(fields).setFooter({text:`Job Application ID: ${job.id}`}).setTimestamp();
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`jobaccept:${job.id}`).setLabel('قبول وفتح تذكرة').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`jobreject:${job.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger)
  );
  const msg=await community.send(ch,{content:`<@&${IDS.JOB_MANAGER_ROLE_ID}> تقديم جديد`,embeds:[embed],components:[row]});
  await mutate(db=>{const a=(db.jobApplications||[]).find(x=>x.id===job.id);if(a)a.reviewMessageId=msg.id});
}

async function createJobTicket(job){
  const guild=await client.guilds.fetch(IDS.JOB_GUILD_ID);
  const categoryId=JOB_TICKET_CATEGORIES[job.type];
  if(!categoryId)throw new Error('JOB_TICKET_CATEGORY_MISSING');
  let applicantMember=null;
  try{ applicantMember=await guild.members.fetch(job.discordId); }catch{}
  const perms=[
    {id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
    {id:IDS.JOB_MANAGER_ROLE_ID,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.EmbedLinks]}
  ];
  if(applicantMember)perms.push({id:job.discordId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.EmbedLinks]});
  if(client.user?.id)perms.push({id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels]});
  const channel=await guild.channels.create({
    name:`${job.type}-${String(job.number).padStart(3,'0')}`,
    type:ChannelType.GuildText,
    parent:categoryId,
    permissionOverwrites:perms,
    topic:`NEXUS Job Application ${job.id} | ${job.realName}`
  });
  const embed=new EmbedBuilder().setColor(0xb83b3b).setTitle(`تذكرة قبول ${JOB_LABELS[job.type]}`).setDescription(applicantMember?`أهلًا <@${job.discordId}>، تم قبول تقديمك. الإدارة هتكمل معاك هنا.`:`تم قبول <@${job.discordId}> لكن العضو غير موجود داخل السيرفر حاليًا.`).addFields(
    {name:'الاسم',value:job.realName,inline:true},
    {name:'الوظيفة',value:JOB_LABELS[job.type],inline:true},
    ...(job.type==='mechanic'?[{name:'الورشة',value:job.workshopName||'—',inline:true}]:[])
  );
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`jobclaim:${job.id}`).setLabel('استلام التذكرة').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`jobclose:${job.id}`).setLabel('إغلاق التذكرة').setStyle(ButtonStyle.Secondary)
  );
  const m=await community.send(channel,{content:`<@${job.discordId}> <@&${IDS.JOB_MANAGER_ROLE_ID}>`,embeds:[embed],components:[row]});
  await mutate(db=>{const a=(db.jobApplications||[]).find(x=>x.id===job.id);if(a){a.ticketChannelId=channel.id;a.ticketMessageId=m.id;}});
  return channel;
}

async function startBot(){
  if(!process.env.DISCORD_BOT_TOKEN){console.warn('DISCORD_BOT_TOKEN is missing. Bot disabled.');return null}
  client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildVoiceStates]});

  installSeasonReset(client,{
    guildId:IDS.GUILD_ID,
    roleIds:process.env.SEASON_RESET_ROLE_IDS
      ? process.env.SEASON_RESET_ROLE_IDS.split(',').map(id=>id.trim()).filter(Boolean)
      : IDS.ADMIN_ROLE_IDS,
    audit:entry=>mutate(db=>{db.audit.push({at:Date.now(),...entry});})
  });
  installSupportAnnouncements(client,IDS.GUILD_ID,frontendUrl);
  installMemberWelcome(client,{guildId:IDS.GUILD_ID,frontendUrl});
  client.once(Events.ClientReady,async c=>{
    console.log(`Discord bot ready as ${c.user.tag}`);
    try {
      const db=await readDB();
      if(db.settings.nexusBotProfileVersion!==4){
        const operations=[
          ['username',()=>c.user.username==='NEXUS'?Promise.resolve():c.user.setUsername('NEXUS')],
          ['avatar',async()=>c.user.setAvatar(await fs.readFile(new URL('./nexus-logo.png',import.meta.url)))],
          ['banner',async()=>c.user.setBanner(await fs.readFile(new URL('./nexus-banner.png',import.meta.url)))],
          ['nickname',async()=>{const guild=await c.guilds.fetch(IDS.GUILD_ID);const me=await guild.members.fetchMe();if(me.nickname&&me.nickname!=='NEXUS')await me.setNickname('NEXUS');}]
        ];
        const results=await Promise.allSettled(operations.map(async([label,run])=>{try{await run();}catch(error){throw new Error(label+': '+error.message);}}));
        for(const result of results)if(result.status==='rejected')console.warn('[NEXUS profile]',result.reason.message);
        if(results.every(result=>result.status==='fulfilled'))await mutate(state=>{state.settings.nexusBotProfileVersion=4;});
      }
      console.log(`[${BUILD_ID}] Bot ${c.user.id}; support audio ${SUPPORT_AUDIO_FILE}`);
    }catch(error){console.warn('NEXUS profile update failed:',error.message);}
  });
  client.on(Events.InteractionCreate,async i=>{try{
    if(i.isButton()&&(i.customId.startsWith('accept:')||i.customId.startsWith('reject:'))){
      if(!(await isReviewer(i))) return i.reply(languagePayload({content:'❌ ليس لديك صلاحية مراجعة التقديمات.',ephemeral:true},await community.languageFor(i.user.id)));
      const [action,id]=i.customId.split(':');

      if(action==='accept'){
        // Acknowledge Discord immediately so the interaction never times out while
        // we update the database, role and DM.
        await i.deferUpdate();

        let app,changed=false;
        await mutate(db=>{
          app=db.applications.find(a=>a.id===id);
          if(app?.status==='pending'){
            app.status='pre_accepted';
            app.reviewedAt=Date.now();
            app.reviewedBy=i.user.id;
            changed=true;
            db.audit.push({at:Date.now(),by:i.user.id,action:'pre_accept',applicationId:id});
          }
        });

        if(!app||!changed){
          return i.followUp(languagePayload({content:'⚠️ تمت مراجعة هذا الطلب بالفعل.',ephemeral:true},await community.languageFor(i.user.id)));
        }

        // Remove buttons first. Role/DM failures must not make Discord show a timeout.
        await i.editReply(languagePayload({content:`✅ قبول مبدئي بواسطة <@${i.user.id}>`,components:[]},await community.languageFor(i.user.id))).catch(()=>{});

        let roleOk=true, dmOk=true;
        try{ await role(app.discordId,IDS.VOICE_REVIEW_ROLE_ID,false); await role(app.discordId,IDS.PRE_ACCEPTED_ROLE_ID,true); }catch{ roleOk=false; }
        const acceptEmbed=turboDmEmbed({
          title:'✅ تم قبول تقديمك مبدئيًا',
          description:'مبروك! تم قبول طلبك مبدئيًا في **NEXUS RP**.',
          fields:[
            {name:'رقم التقديم',value:`#${app.number}`,inline:true},
            {name:'الحالة',value:'مقبول مبدئيًا',inline:true},
            {name:'الخطوة التالية',value:'ادخل الموقع واختر موعد المقابلة الصوتية المناسب لك.',inline:false}
          ],
          colorValue:0x22c55e
        });
        dmOk=await dm(app.discordId,{embeds:[acceptEmbed]});

        await i.followUp(languagePayload({
          content:`✅ تم قبول التقديم #${app.number} مبدئيًا.${roleOk?'':'\n⚠️ راجع صلاحية/ترتيب رول البوت.'}${dmOk?'':'\n⚠️ تعذر إرسال رسالة خاصة للمتقدم.'}`,
          ephemeral:true
        },await community.languageFor(i.user.id))).catch(()=>{});
      } else {
        // showModal itself acknowledges the button interaction, so do it before
        // any database/network work.
        const modal=new ModalBuilder().setCustomId(`rejectmodal:${id}`).setTitle('سبب الرفض');
        const inp=new TextInputBuilder().setCustomId('reason').setLabel('اكتب سبب الرفض').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
        await i.showModal(modal);
      }
    } else if(i.isModalSubmit()&&i.customId.startsWith('rejectmodal:')){
      if(!(await isReviewer(i))) return i.reply(languagePayload({content:'❌ ليس لديك صلاحية مراجعة التقديمات.',ephemeral:true},await community.languageFor(i.user.id)));

      // Modal submissions also have Discord's short response deadline.
      await i.deferReply({ephemeral:true});

      const id=i.customId.split(':')[1], reason=i.fields.getTextInputValue('reason').trim();
      let app,changed=false;
      await mutate(db=>{
        app=db.applications.find(a=>a.id===id);
        if(app?.status==='pending'){
          app.status='rejected';
          app.reason=reason;
          app.reviewedAt=Date.now();
          app.reviewedBy=i.user.id;
          app.cooldownUntil=Date.now()+12*3600*1000;
          changed=true;
          db.audit.push({at:Date.now(),by:i.user.id,action:'reject',applicationId:id,reason});
        }
      });

      if(!app||!changed){
        return i.editReply(languagePayload({content:'⚠️ تمت مراجعة هذا الطلب بالفعل.'},await community.languageFor(i.user.id)));
      }

      // A modal submit does not reliably carry the original review message.
      // Fetch the stored review message and disable its buttons explicitly.
      if(app.reviewMessageId&&IDS.REVIEW_CHANNEL_ID){
        try{
          const ch=await client.channels.fetch(IDS.REVIEW_CHANNEL_ID);
          if(ch?.isTextBased()){
            const msg=await ch.messages.fetch(app.reviewMessageId);
            await msg.edit({content:`❌ تم الرفض بواسطة <@${i.user.id}> — السبب: ${reason}`,components:[]});
          }
        }catch(e){ console.warn('Review message update failed:',e.message); }
      }

      const rejectEmbed=turboDmEmbed({
        title:'❌ تم رفض التقديم',
        description:'تمت مراجعة تقديمك في **NEXUS RP** ولم يتم قبوله هذه المرة.',
        fields:[
          {name:'رقم التقديم',value:`#${app.number}`,inline:true},
          {name:'الحالة',value:'مرفوض',inline:true},
          {name:'سبب الرفض',value:reason.slice(0,1024),inline:false},
          {name:'إعادة التقديم',value:'يمكنك التقديم مرة أخرى بعد **12 ساعة**.',inline:false}
        ],
        colorValue:0xef4444
      });
      await role(app.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
      const dmOk=await dm(app.discordId,{embeds:[rejectEmbed]});

      await i.editReply(languagePayload({content:`✅ تم رفض التقديم #${app.number} وحفظ السبب.${dmOk?'':'\n⚠️ تعذر إرسال رسالة خاصة للمتقدم.'}`},await community.languageFor(i.user.id)));
    }
  }catch(e){
    console.error('Discord interaction error:',e);
    if(!i.isRepliable()) return;
    const payload={content:'❌ حدث خطأ أثناء تنفيذ العملية.',ephemeral:true};
    if(i.deferred||i.replied) await i.followUp(languagePayload(payload,await community.languageFor(i.user.id))).catch(()=>{});
    else await i.reply(languagePayload(payload,await community.languageFor(i.user.id))).catch(()=>{});
  }});

  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}


// ===================== WEBSITE API ==========================

const app=express();
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const frontendUrl=resolveFrontendUrl(process.env.FRONTEND_URL);
const frontendOrigin=(()=>{try{return new URL(frontendUrl).origin}catch{return frontendUrl}})();
const allowedOrigins=[process.env.CORS_ORIGIN,frontendOrigin].filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin,cb){
    if(!origin||allowedOrigins.includes('*')||allowedOrigins.includes(origin)) return cb(null,true);
    return cb(new Error('CORS_NOT_ALLOWED'));
  },
  methods:['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization']
}));
app.use(express.json({limit:'1mb'}));

const questions=[
  'اشرح معنى RDM واديني مثال.',
  'اشرح معنى VDM واديني مثال.',
  'ما هو Meta Gaming؟',
  'ما هو Power Gaming؟',
  'لو اتعرضت لتهديد بسلاح، هتتصرف إزاي؟',
  'هل ينفع تخرج من السيرفر أثناء سيناريو علشان تتجنب نتيجته؟ وضّح.',
  'لو عرفت معلومة من Discord خارج اللعبة، هل ينفع تستخدمها داخل الشخصية؟',
  'احكي باختصار سيناريو رول بلاي تحب تعمله داخل NEXUS RP.'
];

function parseCookies(req){
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}));
}
function oauthState(){return crypto.randomBytes(24).toString('base64url')}
function cookie(name,value,maxAge=600){
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function requireEnv(){
  const needed=['DISCORD_CLIENT_SECRET','DISCORD_BOT_TOKEN','SESSION_SECRET'];
  const missing=needed.filter(k=>!process.env[k]); if(!IDS.CLIENT_ID||!IDS.GUILD_ID||!IDS.REVIEW_CHANNEL_ID) console.warn('⚠️ عدّل Discord IDs في أول index.js');
  if(missing.length) console.warn(`Missing environment variables: ${missing.join(', ')}`);
  if((process.env.SESSION_SECRET||'').length<32) console.warn('SESSION_SECRET should be at least 32 characters.');
}
requireEnv();

app.get('/health',(req,res)=>res.json({ok:true,name:'NEXUS RP',build:BUILD_ID,supportAudio:SUPPORT_AUDIO_FILE,aiConfigured:!!process.env.GEMINI_API_KEY?.trim(),time:new Date().toISOString()}));
app.get('/api/public',asyncRoute(async(req,res)=>{
  const db=await readDB();
  res.json({
    settings:{
      applicationsOpen:db.settings.applicationsOpen,
      creatorApplicationsOpen:db.settings.creatorApplicationsOpen!==false,
      jobApplicationsOpen:db.settings.jobApplicationsOpen!==false,
      jobApplicationAccess:db.settings.jobApplicationAccess,
      aboutText:db.settings.aboutText,
      rules:db.settings.rules,
      news:db.settings.news||[],
      logoImage:db.settings.logoImage||'',
      cityBackground:db.settings.cityBackground||''
    },
    teamMembers:[...(db.teamMembers||[])].sort((a,b)=>(a.order||0)-(b.order||0)),
    mechanicWorkshops:[...(db.mechanicWorkshops||[])].filter(x=>x.active!==false).sort((a,b)=>(a.order||0)-(b.order||0)),
    creators:[...db.creators].sort((a,b)=>(a.order||0)-(b.order||0)),
    questions,
    interviewSlots:db.interviewSlots.filter(s=>!s.bookedBy&&new Date(s.at)>new Date()).sort((a,b)=>new Date(a.at)-new Date(b.at))
  });
}));

app.get('/auth/discord',(req,res)=>{
  if(!IDS.CLIENT_ID||!DISCORD_REDIRECT_URI) return res.status(503).send('Discord OAuth is not configured.');
  const state=oauthState();
  res.setHeader('Set-Cookie',[cookie('turbo_oauth_state',state),cookie('legend_oauth_lang',req.query.lang==='en'?'en':'ar')]);
  const q=new URLSearchParams({
    client_id:IDS.CLIENT_ID,
    redirect_uri:DISCORD_REDIRECT_URI,
    response_type:'code',scope:'identify',state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});

app.get('/auth/discord/callback',asyncRoute(async(req,res)=>{
  const cookies=parseCookies(req);
  if(!req.query.code||!req.query.state||cookies.turbo_oauth_state!==req.query.state) return res.status(400).send('Invalid OAuth state.');
  res.setHeader('Set-Cookie',cookie('turbo_oauth_state','',0));
  const body=new URLSearchParams({
    client_id:IDS.CLIENT_ID,
    client_secret:process.env.DISCORD_CLIENT_SECRET,
    grant_type:'authorization_code',code:String(req.query.code),
    redirect_uri:DISCORD_REDIRECT_URI
  });
  const tr=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:body.toString()});
  const tokenText=await tr.text();
  let tok={};
  try{ tok=JSON.parse(tokenText); }catch{
    console.error('Discord OAuth token returned non-JSON:',tr.status,tokenText.slice(0,180));
    return res.redirect(`${frontendUrl}/#login_error=discord_temporarily_unavailable`);
  }
  if(!tr.ok||!tok.access_token){
    console.error('Discord OAuth token failed:',tr.status,tok.error||tok.error_description||'unknown');
    return res.redirect(`${frontendUrl}/#login_error=discord_oauth_failed`);
  }
  const ur=await fetch('https://discord.com/api/users/@me',{headers:{authorization:`Bearer ${tok.access_token}`,accept:'application/json'}});
  const userText=await ur.text();
  let u={}; try{u=JSON.parse(userText)}catch{console.error('Discord user returned non-JSON:',ur.status,userText.slice(0,180));return res.redirect(`${frontendUrl}/#login_error=discord_temporarily_unavailable`)}
  if(!ur.ok||!u.id) return res.redirect(`${frontendUrl}/#login_error=discord_user_failed`);
  const roles=await getMemberRoles(u.id);
  const token=signToken({id:u.id,username:u.username,globalName:u.global_name,avatar:u.avatar,roles});
  res.redirect(`${frontendUrl}/#token=${encodeURIComponent(token)}`);
  community.register(u,cookies.legend_oauth_lang==='en'?'en':'ar').catch(error=>console.error('Welcome notification failed:',error.message));
}));

function latestApplicationFor(db,discordId){
  return [...db.applications].reverse().filter(a=>a.discordId===discordId).sort((a,b)=>b.createdAt-a.createdAt)[0]||null;
}
function visibleApplicationFor(db,discordId){
  const latest=latestApplicationFor(db,discordId);
  return latest?.status==='reset'?null:latest;
}

app.get('/api/me',auth,asyncRoute(async(req,res)=>{
  const db=await readDB();
  const latest=visibleApplicationFor(db,req.user.id);
  let canApply=db.settings.applicationsOpen,waitMs=0;
  if(latest){
    if(['pending','pre_accepted','voice_review','voice_passed','banned'].includes(latest.status))canApply=false;
    if(['rejected','voice_rejected'].includes(latest.status)&&latest.cooldownUntil>Date.now()){canApply=false;waitMs=latest.cooldownUntil-Date.now()}
  }
  const booked=latest?.interviewSlotId?db.interviewSlots.find(s=>s.id===latest.interviewSlotId):null;
  const jobApplications=(db.jobApplications||[]).filter(a=>a.discordId===req.user.id).sort((a,b)=>b.createdAt-a.createdAt);
  const resolvedStaffRole=isOwner(req.user)?'owner':panelStaffRole(req.user,db);
  res.json({user:req.user,isAdmin:isAdmin(req.user,db),isOwner:isOwner(req.user),isManager:isManager(req.user,db),staffRole:resolvedStaffRole,ownerUserId:String(IDS.OWNER_USER_ID),ownerUserIds:[...OWNER_IDS],latest,canApply,waitMs,booked,jobApplications});
}));

app.post('/api/audit/event',asyncRoute(async(req,res)=>{
  const rawToken=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const viewer=verifyToken(rawToken);
  const action=String(req.body?.action||'').trim().slice(0,80);
  if(!action)return res.status(400).json({error:'AUDIT_ACTION_REQUIRED'});
  const meta=req.body?.meta&&typeof req.body.meta==='object'?req.body.meta:{};
  const cleanMeta={};
  for(const [k,v] of Object.entries(meta).slice(0,20)){
    cleanMeta[String(k).slice(0,60)]=typeof v==='string'?v.slice(0,500):v;
  }
  await mutate(db=>{
    db.audit.push({at:Date.now(),by:viewer?.id||null,visitorId:String(req.body?.visitorId||'').slice(0,80)||null,action:`site_${action}`,path:String(req.body?.path||'').slice(0,240),meta:cleanMeta});
    if(db.audit.length>20000)db.audit=db.audit.slice(-20000);
  });
  res.json({ok:true});
}));

app.post('/api/applications',auth,asyncRoute(async(req,res)=>{
  const {realName,age,story,answers,characterType}=req.body||{};
  if(!/^\S+\s+\S+/.test(String(realName||'').trim()))return res.status(400).json({error:'REAL_NAME_TWO_PARTS'});
  if(Number(age)<16||Number(age)>80)return res.status(400).json({error:'INVALID_AGE'});
  if(String(story||'').length>12000||String(story||'').trim().length<120)return res.status(400).json({error:'STORY_TOO_SHORT'});
  if(!Array.isArray(answers)||answers.length!==questions.length||answers.some(x=>String(x||'').trim().length<10||String(x||'').length>3000))return res.status(400).json({error:'ANSWERS_INCOMPLETE'});
  const allowedCharacterTypes=['criminal','police','mechanic','ems','lawyer','civilian','business'];
  if(!allowedCharacterTypes.includes(String(characterType||'')))return res.status(400).json({error:'INVALID_CHARACTER_TYPE'});

  let created;
  await mutate(db=>{
    if(!db.settings.applicationsOpen)throw new Error('CLOSED');
    const latest=latestApplicationFor(db,req.user.id);
    if(latest&&['pending','pre_accepted','voice_review','voice_passed','banned'].includes(latest.status))throw new Error(latest.status==='banned'?'BANNED':'BLOCKED');
    if(latest&&['rejected','voice_rejected'].includes(latest.status)&&latest.cooldownUntil>Date.now())throw new Error('COOLDOWN');
    db.counters.application=(db.counters.application||0)+1;
    created={
      id:crypto.randomUUID(),number:db.counters.application,discordId:req.user.id,discordTag:req.user.username,
      realName:String(realName).trim(),age:Number(age),story:String(story).trim(),characterType:String(characterType),
      answers:questions.map((q,i)=>({q,a:String(answers[i]).trim()})),ai:reviewState(),
      status:'pending',createdAt:Date.now(),cooldownUntil:0
    };
    db.applications.push(created);
    db.audit.push({at:Date.now(),by:req.user.id,action:'application_create',applicationId:created.id});
  });
  // The database save is authoritative. Discord latency cannot turn a saved request into an error.
  res.json({ok:true,application:created});
  queueReview(created.id);
  try{await role(created.discordId,IDS.VOICE_REVIEW_ROLE_ID,true);await postApplication(created);
    const updated=(await readDB()).applications.find(a=>a.id===created.id);
    if(updated&&updated.ai.status!=='queued'&&updated.ai.status!=='processing')await refreshAiMessage(updated);
  }
  catch(e){console.error('Saved application Discord notification failed:',created.id,e.message);}

}));

app.post('/api/interviews/:slotId/book',auth,asyncRoute(async(req,res)=>{
  let result;
  await mutate(db=>{
    const application=[...db.applications].reverse().find(a=>a.discordId===req.user.id&&a.status==='pre_accepted');
    if(!application)throw new Error('NOT_PRE_ACCEPTED');
    if(application.interviewSlotId)throw new Error('ALREADY_BOOKED');
    const slot=db.interviewSlots.find(s=>s.id===req.params.slotId);
    if(!slot||slot.bookedBy||new Date(slot.at)<=new Date())throw new Error('SLOT_UNAVAILABLE');
    slot.bookedBy=req.user.id;slot.applicationId=application.id;application.interviewSlotId=slot.id;
    db.audit.push({at:Date.now(),by:req.user.id,action:'interview_book',applicationId:application.id,slotId:slot.id});
    result={app:application,slot};
  });
  await notifyInterview(result.app,result.slot);
  res.json({ok:true,...result});
}));


// Admin panel access is Discord-ID allowlist only. Password/role bypasses are disabled.
app.post('/api/admin/password-login',(req,res)=>res.status(404).json({error:'NOT_FOUND'}));

app.get('/api/admin/state',auth,admin,asyncRoute(async(req,res)=>{
  const db=await readDB();
  const panelAdmins=await Promise.all((db.panelAdmins||[]).map(async entry=>{
    const profile=(entry.username&&entry.avatarUrl)?entry:({...entry,...await fetchDiscordProfile(entry.discordId)});
    return {...profile,role:entry.role==='manager'?'manager':'admin'};
  }));
  const ownerProfiles=await Promise.all(OWNER_IDS.map(async discordId=>({
    ...await fetchDiscordProfile(discordId),discordId,role:'owner'
  })));
  const staffDirectory=[...ownerProfiles,...panelAdmins.filter(entry=>!isOwnerId(entry.discordId))];
  const role=panelStaffRole(req.user,db)||'admin';
  res.json({...db,panelAdmins,staffDirectory,viewer:{id:req.user.id,role,isOwner:role==='owner',isManager:role==='owner'||role==='manager'}});
}));

app.get('/api/admin/audit/export',auth,admin,asyncRoute(async(req,res)=>{
  const db=req.db||await readDB();
  const payload={exportedAt:new Date().toISOString(),build:BUILD_VERSION,count:db.audit.length,audit:db.audit};
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename=turbo-audit-log-${Date.now()}.json`);
  res.send(JSON.stringify(payload,null,2));
}));

// ===== BACKUP / RESTORE (OWNER ONLY) =====
// استخدم Export قبل حذف مشروع Railway القديم، وبعدها Import في المشروع الجديد.
app.get('/api/admin/backup/export',auth,owner,asyncRoute(async(req,res)=>{
  const db=await readDB();
  const payload={format:'turbo-rp-backup-v1',exportedAt:Date.now(),data:db};
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="turbo-backup-${stamp}.json"`);
  res.send(JSON.stringify(payload,null,2));
}));

app.post('/api/admin/backup/import',auth,owner,asyncRoute(async(req,res)=>{
  const incoming=req.body?.format==='turbo-rp-backup-v1' ? req.body.data : req.body;
  if(!validateImportedDB(incoming)) return res.status(400).json({error:'INVALID_BACKUP'});
  const restored=structuredClone(incoming);
  restored.audit.push({at:Date.now(),by:req.user.id,action:'backup_import'});
  await writeDB(restored);
  res.json({ok:true,applications:restored.applications.length,panelAdmins:restored.panelAdmins.length});
}));

app.get('/api/admin/storage-status',auth,owner,asyncRoute(async(req,res)=>{
  res.json({ok:true,mode:process.env.DATABASE_URL?'postgres':'local-file',external:!!process.env.DATABASE_URL});
}));

app.patch('/api/admin/settings',auth,admin,asyncRoute(async(req,res)=>{
  const {applicationsOpen,jobApplicationsOpen,jobApplicationAccess,aboutText,rules,news,logoImage,cityBackground}=req.body;
  await mutate(db=>{
    if(typeof applicationsOpen==='boolean')db.settings.applicationsOpen=applicationsOpen;
    if(typeof jobApplicationsOpen==='boolean')db.settings.jobApplicationsOpen=jobApplicationsOpen;
    if(jobApplicationAccess&&typeof jobApplicationAccess==='object'){
      const current=db.settings.jobApplicationAccess||{
        ems:{open:true},
        police:{open:true},
        mechanic:{open:true,mode:'all',workshopId:''}
      };
      if(jobApplicationAccess.ems&&typeof jobApplicationAccess.ems.open==='boolean'){
        current.ems={open:jobApplicationAccess.ems.open};
      }
      if(jobApplicationAccess.police&&typeof jobApplicationAccess.police.open==='boolean'){
        current.police={open:jobApplicationAccess.police.open};
      }
      if(jobApplicationAccess.mechanic&&typeof jobApplicationAccess.mechanic==='object'){
        const m=jobApplicationAccess.mechanic;
        current.mechanic={
          open:typeof m.open==='boolean'?m.open:(current.mechanic?.open!==false),
          mode:['all','one'].includes(m.mode)?m.mode:(current.mechanic?.mode||'all'),
          workshopId:typeof m.workshopId==='string'?m.workshopId:(current.mechanic?.workshopId||'')
        };
      }
      db.settings.jobApplicationAccess=current;
    }
    if(typeof aboutText==='string')db.settings.aboutText=aboutText.slice(0,5000);
    if(Array.isArray(rules))db.settings.rules=rules.map(x=>String(x).slice(0,1000));
    if(Array.isArray(news))db.settings.news=news.slice(0,20).map(x=>({id:String(x.id||crypto.randomUUID()),title:String(x.title||'').slice(0,120),body:String(x.body||'').slice(0,2000),createdAt:Number(x.createdAt||Date.now())})).filter(x=>x.title&&x.body);
    if(typeof logoImage==='string')db.settings.logoImage=logoImage.slice(0,900000);
    if(typeof cityBackground==='string')db.settings.cityBackground=cityBackground.slice(0,4000);
    db.audit.push({at:Date.now(),by:req.user.id,action:'settings_update'});
  });
  res.json({ok:true});
}));

app.post('/api/admin/panel-admins',auth,managerOrOwner,asyncRoute(async(req,res)=>{
  const discordId=String(req.body?.discordId||'').trim();
  const requestedRole=req.body?.role==='manager'?'manager':'admin';
  if(req.staffRole!=='owner' && requestedRole==='manager') return res.status(403).json({error:'OWNER_ONLY_FOR_MANAGER'});
  const staffRole=req.staffRole==='owner'?requestedRole:'admin';
  if(!/^\d{16,22}$/.test(discordId))return res.status(400).json({error:'INVALID_DISCORD_ID'});
  if(isOwnerId(discordId))return res.status(400).json({error:'ALREADY_OWNER'});
  const profile=await fetchDiscordProfile(discordId);
  let entry;
  await mutate(db=>{
    db.panelAdmins=Array.isArray(db.panelAdmins)?db.panelAdmins:[];
    if(db.panelAdmins.some(a=>String(a.discordId)===discordId))throw new Error('ADMIN_EXISTS');
    entry={discordId,role:staffRole,username:profile.username,globalName:profile.globalName,avatarUrl:profile.avatarUrl,addedAt:Date.now(),addedBy:req.user.id};
    db.panelAdmins.push(entry);
    db.audit.push({at:Date.now(),by:req.user.id,action:'panel_staff_add',discordId,role:staffRole});
  });
  res.json({ok:true,admin:entry});
}));
app.delete('/api/admin/panel-admins/:discordId',auth,managerOrOwner,asyncRoute(async(req,res)=>{
  const discordId=String(req.params.discordId||'');
  const current=(req.db?.panelAdmins||[]).find(a=>String(a.discordId)===discordId);
  if(!current)return res.status(404).json({error:'STAFF_NOT_FOUND'});
  if(req.staffRole!=='owner' && current.role==='manager')return res.status(403).json({error:'OWNER_ONLY_FOR_MANAGER'});
  await mutate(db=>{
    db.panelAdmins=(db.panelAdmins||[]).filter(a=>String(a.discordId)!==discordId);
    db.audit.push({at:Date.now(),by:req.user.id,action:'panel_staff_remove',discordId});
  });
  res.json({ok:true});
}));

async function updateReviewMessage(appRecord,text){
  if(!client?.isReady()||!appRecord?.reviewMessageId||!IDS.REVIEW_CHANNEL_ID)return;
  try{
    const ch=await client.channels.fetch(IDS.REVIEW_CHANNEL_ID);
    if(!ch?.isTextBased())return;
    const msg=await ch.messages.fetch(appRecord.reviewMessageId);
    await msg.edit({content:text,components:[]});
  }catch(e){console.warn('Review message update failed:',e.message)}
}

app.post('/api/admin/applications/:id/ai-review',auth,admin,asyncRoute(async(req,res)=>{
  const record=req.db.applications.find(a=>a.id===req.params.id);
  if(!record)return res.status(404).json({error:'APPLICATION_NOT_FOUND'});
  if(aiJobs.has(record.id))return res.status(202).json({ok:true,status:'queued'});
  if(record.ai?.status==='completed')return res.json({ok:true,status:'completed',ai:record.ai});
  if(!process.env.GEMINI_API_KEY?.trim())return res.status(503).json({error:'GEMINI_KEY_MISSING'});
  if(Date.now()-(aiRetryByUser.get(req.user.id)||0)<60000)return res.status(429).json({error:'WAIT_ONE_MINUTE'});
  aiRetryByUser.set(req.user.id,Date.now());
  if(aiRetryByUser.size>1000)for(const [id,t]of aiRetryByUser)if(Date.now()-t>60000)aiRetryByUser.delete(id);
  await mutate(db=>{const a=db.applications.find(x=>x.id===record.id);if(a)a.ai=reviewState();});
  queueReview(record.id);res.status(202).json({ok:true,status:'queued'});
}));

app.post('/api/admin/applications/:id/action',auth,admin,asyncRoute(async(req,res)=>{
  const action=String(req.body?.action||'').trim();
  const reason=String(req.body?.reason||'').trim().slice(0,500);
  const allowed=['pre_accept','reject','voice_review','voice_pass','voice_reject','ban','reset'];
  if(!allowed.includes(action))return res.status(400).json({error:'INVALID_ACTION'});
  let a,previous;
  await mutate(db=>{
    a=db.applications.find(x=>x.id===req.params.id);
    if(!a)throw new Error('APPLICATION_NOT_FOUND');
    previous=a.status;
    const now=Date.now();
    if(action==='pre_accept'){
      if(a.status!=='pending')throw new Error('INVALID_STAGE');
      a.status='pre_accepted';a.reason='';a.reviewedAt=now;a.reviewedBy=req.user.id;a.cooldownUntil=0;
    }else if(action==='reject'){
      if(a.status!=='pending')throw new Error('INVALID_STAGE');
      a.status='rejected';a.reason=reason||'لم يتم تحديد سبب';a.reviewedAt=now;a.reviewedBy=req.user.id;a.cooldownUntil=now+12*3600*1000;
    }else if(action==='voice_review'){
      if(!['pre_accepted','voice_review'].includes(a.status))throw new Error('INVALID_STAGE');
      a.status='voice_review';a.voiceReviewedAt=now;a.voiceReviewedBy=req.user.id;
    }else if(action==='voice_pass'){
      if(!['pre_accepted','voice_review'].includes(a.status))throw new Error('INVALID_STAGE');
      a.status='voice_passed';a.voicePassedAt=now;a.voiceReviewedBy=req.user.id;a.reason='';a.cooldownUntil=0;
    }else if(action==='voice_reject'){
      if(!['pre_accepted','voice_review'].includes(a.status))throw new Error('INVALID_STAGE');
      a.status='voice_rejected';a.reason=reason||'';a.voiceReviewedAt=now;a.voiceReviewedBy=req.user.id;a.cooldownUntil=now+12*3600*1000;
      for(const slot of db.interviewSlots){if(slot.bookedBy===a.discordId){slot.bookedBy=null;slot.applicationId=null}}
      a.interviewSlotId=null;
    }else if(action==='ban'){
      a.status='banned';a.reason=reason||'حظر دائم من التقديم';a.bannedAt=now;a.bannedBy=req.user.id;a.cooldownUntil=0;
      for(const slot of db.interviewSlots){if(slot.bookedBy===a.discordId){slot.bookedBy=null;slot.applicationId=null}}
      a.interviewSlotId=null;
    }else if(action==='reset'){
      if(latestApplicationFor(db,a.discordId)?.id!==a.id)throw new Error('NEWER_APPLICATION_EXISTS');
      a.status='reset';a.reason='';a.cooldownUntil=0;a.interviewSlotId=null;
      for(const slot of db.interviewSlots){if(slot.bookedBy===a.discordId){slot.bookedBy=null;slot.applicationId=null}}
    }
    db.audit.push({at:now,by:req.user.id,action:`application_${action}`,applicationId:a.id,from:previous,to:a.status,reason});
  });

  if(action==='pre_accept'){
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await role(a.discordId,IDS.PRE_ACCEPTED_ROLE_ID,true);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'✅ تم قبول تقديمك مبدئيًا',description:'تم قبول طلبك مبدئيًا في **NEXUS RP**.',fields:[{name:'رقم التقديم',value:`#${a.number}`,inline:true},{name:'الخطوة التالية',value:'ادخل الموقع واختر موعد المقابلة الصوتية.',inline:false}],colorValue:0x22c55e})]});
    await updateReviewMessage(a,`✅ قبول مبدئي من لوحة التحكم بواسطة <@${req.user.id}>`);
  }else if(action==='reject'){
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'❌ تم رفض التقديم',description:'تمت مراجعة تقديمك ولم يتم قبوله هذه المرة.',fields:[{name:'السبب',value:a.reason||'لم يتم تحديد سبب'},{name:'إعادة التقديم',value:'بعد 12 ساعة'}],colorValue:0xef4444})]});
    await updateReviewMessage(a,`❌ رفض من لوحة التحكم بواسطة <@${req.user.id}> — ${a.reason||'بدون سبب'}`);
  }else if(action==='voice_review'){
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,true);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'🕒 المقابلة قيد المراجعة',description:'تم وضع نتيجة المقابلة الصوتية قيد المراجعة من الإدارة.'})]});
  }else if(action==='voice_pass'){
    await role(a.discordId,IDS.PRE_ACCEPTED_ROLE_ID,false);
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_A_ID,false);
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_B_ID,false);
    await role(a.discordId,IDS.ENTRY_ROLE_ID,true);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'✅ تم قبولك نهائيًا',description:'تم اجتياز المقابلة الصوتية ومنحك تصريح الدخول.',colorValue:0x22c55e})]});
  }else if(action==='voice_reject'){
    await role(a.discordId,IDS.PRE_ACCEPTED_ROLE_ID,false);
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    // الرفض الصوتي يتناوب A ثم B ثم A ثم B... مع إزالة رول الرفض السابق.
    const dbNow=await readDB();
    const rejects=dbNow.applications.filter(x=>x.discordId===a.discordId&&x.status==='voice_rejected').length;
    const odd=rejects%2===1;
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_A_ID,false);
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_B_ID,false);
    await role(a.discordId,odd?IDS.VOICE_REJECT_ROLE_A_ID:IDS.VOICE_REJECT_ROLE_B_ID,true);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'❌ لم تجتز المقابلة الصوتية',description:a.reason?`السبب: ${a.reason}`:'لم يتم تحديد سبب.',fields:[{name:'إعادة التقديم',value:'بعد 12 ساعة'}],colorValue:0xef4444})]});
  }else if(action==='ban'){
    await role(a.discordId,IDS.PRE_ACCEPTED_ROLE_ID,false);
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_A_ID,false);
    await role(a.discordId,IDS.VOICE_REJECT_ROLE_B_ID,false);
    await role(a.discordId,IDS.ENTRY_ROLE_ID,false);
    await dm(a.discordId,{embeds:[turboDmEmbed({title:'⛔ حظر دائم من التقديم',description:a.reason||'تم حظرك بشكل دائم من التقديم.',colorValue:0x991b1b})]});
  }else if(action==='reset'){
    // رول قيد المراجعة موجود فقط أثناء المراجعة، لذلك يتشال عند السماح بإعادة التقديم.
    await role(a.discordId,IDS.VOICE_REVIEW_ROLE_ID,false);
    await role(a.discordId,IDS.PRE_ACCEPTED_ROLE_ID,false);
  }
  res.json({ok:true,application:a});
}));




app.post('/api/job-applications',auth,asyncRoute(async(req,res)=>{
  { const db=await readDB(); if(db.settings.jobApplicationsOpen===false)return res.status(403).json({error:'JOB_APPLICATIONS_CLOSED'}); }
  const {type,realName,age,experience,why,availability,workshopId}=req.body||{};
  const jobType=String(type||'');
  if(!['ems','police','mechanic'].includes(jobType))return res.status(400).json({error:'INVALID_JOB_TYPE'});
  if(!/^\S+\s+\S+/.test(String(realName||'').trim()))return res.status(400).json({error:'REAL_NAME_TWO_PARTS'});
  if(Number(age)<16||Number(age)>80)return res.status(400).json({error:'INVALID_AGE'});
  if(String(experience||'').trim().length<20||String(why||'').trim().length<20)return res.status(400).json({error:'JOB_ANSWERS_SHORT'});
  let created;
  await mutate(db=>{
    db.jobApplications=Array.isArray(db.jobApplications)?db.jobApplications:[];
    db.mechanicWorkshops=Array.isArray(db.mechanicWorkshops)?db.mechanicWorkshops:[];
    const active=db.jobApplications.find(x=>x.discordId===req.user.id&&x.type===jobType&&x.status==='pending');
    if(active)throw new Error('JOB_ALREADY_PENDING');
    let workshopName='';
    if(jobType==='mechanic'){
      const mechanicAccess=db.settings.jobApplicationAccess?.mechanic||{open:true,mode:'all',workshopId:''};
      if(mechanicAccess.open===false)throw new Error('JOB_DEPARTMENT_CLOSED');
      if(mechanicAccess.mode==='one' && String(workshopId||'')!==String(mechanicAccess.workshopId||'')){
        throw new Error('WORKSHOP_CLOSED');
      }
      const w=db.mechanicWorkshops.find(x=>x.id===String(workshopId||'')&&x.active!==false);
      if(!w)throw new Error('WORKSHOP_REQUIRED');
      workshopName=w.name;
    }
    db.counters.jobApplication=(db.counters.jobApplication||0)+1;
    created={id:crypto.randomUUID(),number:db.counters.jobApplication,discordId:req.user.id,discordTag:req.user.username,type:jobType,realName:String(realName).trim(),age:Number(age),experience:String(experience).trim(),why:String(why).trim(),availability:String(availability||'').trim(),workshopId:jobType==='mechanic'?String(workshopId):null,workshopName,status:'pending',createdAt:Date.now()};
    db.jobApplications.push(created);db.audit.push({at:Date.now(),by:req.user.id,action:'job_application_create',jobApplicationId:created.id,type:jobType});
  });
  await postJobApplication(created);
  res.json({ok:true,application:created});
}));

app.post('/api/admin/mechanic-workshops',auth,admin,asyncRoute(async(req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,100);if(!name)return res.status(400).json({error:'WORKSHOP_NAME_REQUIRED'});
  const item={id:crypto.randomUUID(),name,order:Number(req.body?.order||0),active:true,createdAt:Date.now()};
  await mutate(db=>{db.mechanicWorkshops=Array.isArray(db.mechanicWorkshops)?db.mechanicWorkshops:[];db.mechanicWorkshops.push(item);db.audit.push({at:Date.now(),by:req.user.id,action:'workshop_add',workshopId:item.id,name});});
  res.json({ok:true,workshop:item});
}));
app.delete('/api/admin/mechanic-workshops/:id',auth,admin,asyncRoute(async(req,res)=>{await mutate(db=>{db.mechanicWorkshops=(db.mechanicWorkshops||[]).filter(x=>x.id!==req.params.id);db.audit.push({at:Date.now(),by:req.user.id,action:'workshop_remove',workshopId:req.params.id});});res.json({ok:true});}));

app.post('/api/admin/team-members',auth,admin,asyncRoute(async(req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,80);
  const rank=String(req.body?.rank||'').trim().slice(0,80);
  const image=String(req.body?.image||'').trim().slice(0,2000);
  const order=Number(req.body?.order||0);
  if(!name||!rank||!image)return res.status(400).json({error:'MISSING_TEAM_DATA'});

  const member={
    id:crypto.randomUUID(),
    name,
    rank,
    image,
    order:Number.isFinite(order)?order:0,
    createdAt:Date.now(),
    createdBy:req.user.id
  };

  await mutate(db=>{
    db.teamMembers=Array.isArray(db.teamMembers)?db.teamMembers:[];
    db.teamMembers.push(member);
    db.audit.push({at:Date.now(),by:req.user.id,action:'public_team_add',teamMemberId:member.id});
  });

  res.json({ok:true,member});
}));

app.delete('/api/admin/team-members/:id',auth,admin,asyncRoute(async(req,res)=>{
  const id=String(req.params.id||'');
  await mutate(db=>{
    db.teamMembers=Array.isArray(db.teamMembers)?db.teamMembers:[];
    db.teamMembers=db.teamMembers.filter(x=>x.id!==id);
    db.audit.push({at:Date.now(),by:req.user.id,action:'public_team_remove',teamMemberId:id});
  });
  res.json({ok:true});
}));

app.post('/api/admin/creators',auth,admin,asyncRoute(async(req,res)=>{
  let c;
  await mutate(db=>{
    c={id:crypto.randomUUID(),name:String(req.body.name||'').trim(),image:String(req.body.image||'').trim(),url:String(req.body.url||'').trim(),order:Number(req.body.order||0),platform:String(req.body.platform||'other'),platformId:String(req.body.platformId||'').trim(),isLive:false,lastCheckedAt:0};
    if(!c.name||!c.url)throw new Error('CREATOR_INVALID');
    db.creators.push(c);
    db.audit.push({at:Date.now(),by:req.user.id,action:'creator_add',creatorId:c.id});
  });
  res.json(c);
}));
app.delete('/api/admin/creators/:id',auth,admin,asyncRoute(async(req,res)=>{await mutate(db=>{db.creators=db.creators.filter(c=>c.id!==req.params.id);db.audit.push({at:Date.now(),by:req.user.id,action:'creator_remove',creatorId:req.params.id})});res.json({ok:true})}));
app.post('/api/admin/interviews',auth,admin,asyncRoute(async(req,res)=>{
  const at=new Date(req.body.at);
  if(Number.isNaN(at.getTime())||at<=new Date())return res.status(400).json({error:'INVALID_INTERVIEW_DATE'});
  let slot;
  await mutate(db=>{slot={id:crypto.randomUUID(),at:at.toISOString(),note:String(req.body.note||'').slice(0,500),bookedBy:null,applicationId:null};db.interviewSlots.push(slot);db.audit.push({at:Date.now(),by:req.user.id,action:'interview_add',slotId:slot.id})});
  res.json(slot);
}));
app.delete('/api/admin/interviews/:id',auth,admin,asyncRoute(async(req,res)=>{await mutate(db=>{const s=db.interviewSlots.find(x=>x.id===req.params.id);if(s?.bookedBy)throw new Error('BOOKED');db.interviewSlots=db.interviewSlots.filter(x=>x.id!==req.params.id);db.audit.push({at:Date.now(),by:req.user.id,action:'interview_remove',slotId:req.params.id})});res.json({ok:true})}));
app.post('/api/admin/users/:discordId/reset',auth,admin,asyncRoute(async(req,res)=>{
  await mutate(db=>{
    const latest=latestApplicationFor(db,req.params.discordId);
    if(latest){latest.status='reset';latest.reason='';latest.cooldownUntil=0;latest.interviewSlotId=null}
    for(const slot of db.interviewSlots){if(slot.bookedBy===req.params.discordId){slot.bookedBy=null;slot.applicationId=null}}
    db.audit.push({at:Date.now(),by:req.user.id,action:'reset_apply',userId:req.params.discordId});
  });
  res.json({ok:true});
}));
app.post('/api/admin/users/:discordId/voice-pass',auth,admin,asyncRoute(async(req,res)=>{const a=await markVoicePassed(req.params.discordId,req.user.id);if(!a)return res.status(404).json({error:'NO_PRE_ACCEPTED_APPLICATION'});res.json({ok:true,application:a})}));

let twitchToken=null,twitchTokenExpires=0;
async function getTwitchToken(){
  if(twitchToken&&Date.now()<twitchTokenExpires-60000)return twitchToken;
  const r=await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(process.env.TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`,{method:'POST'});
  const j=await r.json();
  twitchToken=j.access_token;twitchTokenExpires=Date.now()+(Number(j.expires_in||3600)*1000);return twitchToken;
}
async function checkLives(){
  const db=await readDB();
  for(const c of db.creators){
    let live=false;
    try{
      if(c.platform==='youtube'&&process.env.YOUTUBE_API_KEY&&c.platformId){
        const u=`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(c.platformId)}&eventType=live&type=video&key=${process.env.YOUTUBE_API_KEY}`;
        const j=await (await fetch(u)).json();live=Array.isArray(j.items)&&j.items.length>0;
      }else if(c.platform==='twitch'&&process.env.TWITCH_CLIENT_ID&&process.env.TWITCH_CLIENT_SECRET&&c.platformId){
        const token=await getTwitchToken();
        const r=await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(c.platformId)}`,{headers:{'Client-ID':process.env.TWITCH_CLIENT_ID,Authorization:`Bearer ${token}`}});
        const j=await r.json();live=Array.isArray(j.data)&&j.data.length>0;
      }
    }catch(e){console.error('live check',c.name,e.message)}
    await mutate(x=>{const cc=x.creators.find(z=>z.id===c.id);if(cc){cc.isLive=live;cc.lastCheckedAt=Date.now()}});
  }
}

const community=installCommunity({app,auth,readDB,mutate,asyncRoute,getClient:()=>client,frontendUrl,dm});
const bindCreatorDiscord=installCreators({sendBotMessage:(target,payload)=>community.send(target,payload),app,auth,admin,readDB,mutate,dm,frontendUrl,crypto,asyncRoute,getClient:()=>client,IDS,isAdmin});
installStore({app,auth,admin,readDB,mutate,dm,frontendUrl,crypto,asyncRoute});
app.use(express.static('public'));
app.use((err,req,res,next)=>{
  console.error(err);
  const map={CLOSED:403,BLOCKED:409,BANNED:403,COOLDOWN:429,NOT_PRE_ACCEPTED:403,ALREADY_BOOKED:409,SLOT_UNAVAILABLE:409,BOOKED:409,CORS_NOT_ALLOWED:403,CREATOR_INVALID:400,APPLICATION_NOT_FOUND:404,INVALID_STAGE:409,ADMIN_EXISTS:409,INVALID_CHARACTER_TYPE:400,INVALID_JOB_TYPE:400,JOB_ANSWERS_SHORT:400,JOB_ALREADY_PENDING:409,WORKSHOP_REQUIRED:400,WORKSHOP_NAME_REQUIRED:400};
  res.status(map[err.message]||500).json({error:err.message||'SERVER_ERROR'});
});

const port=process.env.PORT||3000;
app.listen(port,'0.0.0.0',()=>{console.log(`NEXUS API ${BUILD_VERSION} listening on ${port}`);mutate(db=>{db.audit.push({at:Date.now(),by:'system',action:'system_deploy',build:BUILD_VERSION})}).catch(()=>{})});
startBot().catch(e=>console.error('Discord bot failed:',e));
bindCreatorDiscord();
community.bind();
setInterval(checkLives,Math.max(1,Number(process.env.LIVE_CHECK_MINUTES||3))*60*1000);
setTimeout(checkLives,5000);

// Resume saved unfinished jobs after a host restart; terminal failures await staff retry.
mutate(db=>db.applications.filter(a=>['queued','processing'].includes(a.ai?.status)).map(a=>a.id)).then(ids=>{for(const id of ids)queueReview(id);}).catch(()=>{});
