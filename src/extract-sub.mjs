import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('extracted_subtitles');

const LANG_MAP = {
  ara: 'Arabic', ar: 'Arabic',
  eng: 'English', en: 'English',
  spa: 'Spanish', es: 'Spanish',
  ita: 'Italian', it: 'Italian',
  fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German',
  jpn: 'Japanese', ja: 'Japanese',
  por: 'Portuguese', pt: 'Portuguese',
  rus: 'Russian', ru: 'Russian',
  ind: 'Indonesian', id: 'Indonesian',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  kor: 'Korean', ko: 'Korean',
  und: 'Other'
};

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function findAllVideoFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllVideoFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.mkv', '.mp4', '.avi', '.webm'].includes(ext)) results.push(fullPath);
    }
  }
  return results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function normalizeUrl(rawUrl) {
  let u = rawUrl.trim();
  const nyaaMatch = u.match(/^https?:\/\/(?:www\.)?nyaa\.si\/view\/(\d+)/i);
  if (nyaaMatch) return `https://nyaa.si/download/${nyaaMatch[1]}.torrent`;
  const sukebeiMatch = u.match(/^https?:\/\/(?:www\.)?sukebei\.nyaa\.si\/view\/(\d+)/i);
  if (sukebeiMatch) return `https://sukebei.nyaa.si/download/${sukebeiMatch[1]}.torrent`;
  return u;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
}

async function resolveMediafireDirectUrl(mfUrl) {
  try {
    const res = await fetch(mfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const match = html.match(/href=["'](https?:\/\/[^"']*mediafire\.com\/[^"']*\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)["']/i) ||
                  html.match(/aria-label=["']Download file["']\s+href=["']([^"']+)["']/i) ||
                  html.match(/id=["']downloadButton["']\s+href=["']([^"']+)["']/i);
    if (match) return match[1];
  } catch (e) {}
  return mfUrl;
}

export async function extractSubtitles(rawUrl, outputName) {
  let inputUrl = normalizeUrl(rawUrl);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const workDir = path.resolve('temp_work');
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const safeBundleName = sanitizeFilename(outputName || 'Subtitles_Batch');
  const targetSubDir = path.join(OUT_DIR, safeBundleName);
  if (fs.existsSync(targetSubDir)) fs.rmSync(targetSubDir, { recursive: true, force: true });
  fs.mkdirSync(targetSubDir, { recursive: true });
  const fontsDir = path.join(targetSubDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });

  console.log(`\n🎬 Starting extraction for: ${safeBundleName}`);
  console.log(`🔗 Input URL: ${inputUrl}\n`);

  // 1. تنزيل الملفات
  if (inputUrl.startsWith('magnet:') || inputUrl.includes('.torrent') || inputUrl.includes('nyaa.si')) {
    run(`aria2c --seed-time=0 --summary-interval=10 --file-allocation=none --bt-max-peers=128 --bt-tracker-connect-timeout=10 --max-connection-per-server=16 --split=16 --dir="${workDir}" "${inputUrl}"`);
  } else if (inputUrl.includes('drive.google.com')) {
    run(`gdown "${inputUrl}" -O "${workDir}/" --fuzzy ${inputUrl.includes('/folders/') ? '--folder' : ''}`);
  } else if (inputUrl.includes('mediafire.com')) {
    const directMf = await resolveMediafireDirectUrl(inputUrl);
    run(`aria2c --dir="${workDir}" --file-allocation=none --summary-interval=10 "${directMf}"`);
  } else if (inputUrl.includes('mega.nz')) {
    try {
      run(`megatools dl --path "${workDir}" "${inputUrl}"`);
    } catch {
      run(`python3 -c "from mega import Mega; m = Mega(); m.login(); m.download_url('${inputUrl}', '${workDir}')"`);
    }
  } else if (inputUrl.startsWith('http')) {
    run(`aria2c --dir="${workDir}" --file-allocation=none --summary-interval=10 "${inputUrl}"`);
  }

  // 2. اكتشاف الحلقات
  const videoFiles = findAllVideoFiles(workDir);
  if (videoFiles.length === 0) throw new Error('❌ لم يتم العثور على أي ملف فيديو');

  console.log(`\n📦 تم العثور على ${videoFiles.length} حلقة.`);
  let totalSubs = 0;
  const seenFontNames = new Set();

  // 3. استخراج الترجمات داخل مجلدات حسب اللغة
  for (let idx = 0; idx < videoFiles.length; idx++) {
    const vFile = videoFiles[idx];
    const baseName = sanitizeFilename(path.basename(vFile, path.extname(vFile)));
    console.log(`\n⚡ معالجة [${idx + 1}/${videoFiles.length}]: ${baseName}`);

    let mkvInfo = null;
    try {
      const infoRaw = spawnSync('mkvmerge', ['-J', vFile], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (infoRaw.stdout) mkvInfo = JSON.parse(infoRaw.stdout);
    } catch {}

    if (mkvInfo && Array.isArray(mkvInfo.tracks)) {
      const subTracks = mkvInfo.tracks.filter((t) => t.type === 'subtitles');
      const attachments = (mkvInfo.attachments || []).filter((a) => /\.(ttf|otf|ttc|woff|woff2)$/i.test(a.file_name || ''));

      for (const trk of subTracks) {
        const codec = (trk.codec || '').toLowerCase();
        const ext = codec.includes('subrip') || codec.includes('srt') ? 'srt' : 'ass';
        const langCode = (trk.properties?.language || trk.properties?.language_ietf || 'und').toLowerCase();
        const langFolder = LANG_MAP[langCode] || langCode.toUpperCase();
        
        const langDir = path.join(targetSubDir, langFolder);
        fs.mkdirSync(langDir, { recursive: true });

        const trackTitle = trk.properties?.track_name ? `_[${sanitizeFilename(trk.properties.track_name)}]` : '';
        const subOutFile = path.join(langDir, `${baseName}${trackTitle}.${ext}`);

        try {
          run(`mkvextract tracks "${vFile}" ${trk.id}:"${subOutFile}"`);
          totalSubs++;
        } catch {
          run(`ffmpeg -y -i "${vFile}" -map 0:${trk.id} -c:s copy "${subOutFile}"`);
          totalSubs++;
        }
      }

      if (attachments.length > 0) {
        const toExtract = [];
        for (const att of attachments) {
          const fName = sanitizeFilename(att.file_name || `font_${att.id}.ttf`);
          if (!seenFontNames.has(fName.toLowerCase())) {
            seenFontNames.add(fName.toLowerCase());
            toExtract.push(`${att.id}:"${path.join(fontsDir, fName)}"`);
          }
        }
        if (toExtract.length > 0) {
          try {
            run(`mkvextract attachments "${vFile}" ${toExtract.join(' ')}`);
          } catch {}
        }
      }
    }
  }

  if (fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length === 0) fs.rmdirSync(fontsDir);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`\n🎉 اكتمل الاستخراج بنجاح! تم استخراج ${totalSubs} ملف ترجمة.`);
}

if (process.argv[1]?.endsWith('extract.mjs')) {
  const url = process.argv[2] || '';
  const name = process.argv[3] || 'Subtitles';
  extractSubtitles(url, name).catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  });
}
