'use strict';
/*
  Линкээс файл татах (Google Drive / Docs / Sheets, OneDrive / SharePoint, энгийн https линк).

  Хамгаалалт:
  - Зөвхөн https://. Redirect бүрийн хаягийг DNS-ээр шийдэж, localhost / дотоод сүлжээний
    (10.x, 192.168.x, 172.16-31.x, 169.254.x гэх мэт) IP рүү хандахыг хориглоно.
  - Хэмжээ maxBytes-аас хэтэрвэл тасална; холболт 60 сек хариу өгөхгүй бол тасална.
  - Google Drive холбогдсон бол (server/gdrive.js) Google линкийг тэр дансны эрхээр Drive API-аар татна —
    Authorization header-ийг зөвхөн www.googleapis.com руу илгээнэ. Холбогдоогүй бол линк «Anyone with the link» байх ёстой.
*/

const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const GD = require('./gdrive');

const MIME_EXT = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
  'application/pdf': '.pdf', 'text/csv': '.csv', 'text/plain': '.txt', 'text/markdown': '.md',
  'image/png': '.png', 'image/jpeg': '.jpg',
};

/* Хуваалцах линкийг шууд татах линк болгох */
function normalize(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('Линк буруу байна'); }
  if (u.protocol !== 'https:') throw new Error('Зөвхөн https:// линк зөвшөөрөгдөнө');
  const h = u.hostname.toLowerCase();
  let m;
  if (h === 'docs.google.com' && (m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/))) {
    if (m[1] === 'presentation') throw new Error('Google Slides дэмжигдэхгүй');
    const fmt = m[1] === 'document' ? 'docx' : 'xlsx';
    return { url: `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=${fmt}`, source: 'google', gid: m[2] };
  }
  if (h === 'drive.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get('id');
    if (!id) throw new Error('Google Drive-ийн файлын линк оруулна уу (хавтасны линк биш)');
    return { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, source: 'google', gid: id };
  }
  if (/(^|\.)sharepoint\.com$|(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$/.test(h)) {
    u.searchParams.set('download', '1');
    return { url: u.href, source: 'microsoft' };
  }
  return { url: u.href, source: 'web' };
}

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Линк https биш хаяг руу шилжүүлж байна');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`${host} хаяг олдсонгүй`); });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Дотоод сүлжээний хаяг руу хандахыг хориглосон');
}

function nameFromDisposition(cd) {
  if (!cd) return '';
  let m = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch {} }
  m = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  if (!m) return '';
  const n = (m[1] || m[2]).trim();
  try { return Buffer.from(n, 'latin1').toString('utf8'); } catch { return n; }   // UTF-8 нэрийг latin1 гэж илгээсэн тохиолдол
}

/* url-ээс татаж destFn(name)-ийн буцаасан замд хадгална. { name, size, path } буцаана. */
async function download(raw, { maxBytes, destFn, timeoutMs = 60000 }) {
  let { url, source, gid } = normalize(raw);
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), timeoutMs); };
  try {
    let res, drive = null;
    if (gid && GD.connected()) { drive = await GD.resolve(gid, ctl.signal); url = drive.url; }
    for (let hop = 0; ; hop++) {
      if (hop > 6) throw new Error('Хэт олон redirect');
      await assertPublic(url);
      const auth = drive && new URL(url).hostname === 'www.googleapis.com' ? drive.headers : {};
      res = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 AuditReviewAgent', ...auth } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
      break;
    }
    if (res.status === 401 || res.status === 403) throw new Error(drive ? `Файлд ${GD.status().email || 'холбосон данс'}-ийн эрхээр хандаж чадсангүй` : 'Файлд хандах эрхгүй байна. Линкийн эрхийг «Anyone with the link — Viewer» болгоно уу');
    if (res.status === 404) throw new Error('Файл олдсонгүй (404)');
    if (!res.ok) throw new Error(`Татаж чадсангүй (HTTP ${res.status})`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html') {
      throw new Error(source === 'google'
        ? 'Google нэвтрэх хуудас буцаалаа — файл хувийн эрхтэй байна. Админ «Хэрэглэгчид» хуудаснаас Google Drive-ийг холбох, эсвэл «Share → Anyone with the link» болгож дахин оролдоно уу'
        : 'Линк файл биш вэб хуудас руу заасан байна. Шууд татах линк оруулна уу');
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (maxBytes && len > maxBytes) throw new Error(`Файл ${Math.round(maxBytes / 1048576)} MB-аас том байна`);
    let name = drive ? drive.name : nameFromDisposition(res.headers.get('content-disposition'));
    if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { name = ''; } }
    if (!/\.[a-z0-9]{2,5}$/i.test(name) && MIME_EXT[type]) name = (name || 'linkfile') + MIME_EXT[type];
    if (!name) name = 'linkfile';
    const dest = destFn(name);
    const ws = fs.createWriteStream(dest.path);
    let n = 0;
    try {
      for await (const chunk of res.body) {
        n += chunk.length; bump();
        if (maxBytes && n > maxBytes) throw new Error(`Файл ${Math.round(maxBytes / 1048576)} MB-аас том байна`);
        if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r));
      }
      await new Promise((r, j) => ws.end(e => e ? j(e) : r()));
    } catch (e) { ws.destroy(); try { fs.rmSync(dest.path, { force: true }); } catch {} throw e; }
    return { name: dest.name, path: dest.path, size: n, via: drive ? 'drive' : 'public', owner: drive ? drive.owner : '' };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Линкээс хариу ирэхгүй байна (60 сек)');
    if (e.cause && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(e.cause.code || '')) throw new Error(`Холбогдож чадсангүй (${e.cause.code})`);
    throw e;
  } finally { clearTimeout(timer); }
}

module.exports = { download, normalize, isPrivateIp };
