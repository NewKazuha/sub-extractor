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

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Turbo Extraction: ${safeBundleName}`);
  console.log(`🔗 Input URL: ${inputUrl}`);
  console.log(`======================================================\n`);

  // 1. Download source files with maximum multi-threading & memory mapping
  if (inputUrl.startsWith('magnet:') || inputUrl.includes('.torrent') || inputUrl.includes('nyaa.si')) {
    const ariaArgs = [
      '--seed-time=0',
      '--summary-interval=5',
      '--file-allocation=none',
      '--enable-mmap=true',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--bt-max-peers=256',
      '--bt-tracker-connect-timeout=5',
      '--bt-tracker-timeout=10',
      '--peer-id-prefix=-TR2940-',
      `--dir="${workDir}"`,
      `"${inputUrl}"`
    ].join(' ');
    run(`aria2c ${ariaArgs}`);
  } else if (inputUrl.includes('drive.google.com')) {
    run(`gdown "${inputUrl}" -O "${workDir}/" --fuzzy ${inputUrl.includes('/folders/') ? '--folder' : ''}`);
  } else if (inputUrl.includes('mediafire.com')) {
    const directMf = await resolveMediafireDirectUrl(inputUrl);
    run(`aria2c --dir="${workDir}" --file-allocation=none --enable-mmap=true --max-connection-per-server=16 --split=16 "${directMf}"`);
  } else if (inputUrl.includes('mega.nz')) {
    try {
      run(`megatools dl --path "${workDir}" "${inputUrl}"`);
    } catch {
      run(`python3 -c "from mega import Mega; m = Mega(); m.login(); m.download_url('${inputUrl}', '${workDir}')"`);
    }
  } else if (inputUrl.startsWith('http')) {
    run(`aria2c --dir="${workDir}" --file-allocation=none --enable-mmap=true --max-connection-per-server=16 --split=16 "${inputUrl}"`);
  }

  // 2. Discover all video files
  const videoFiles = findAllVideoFiles(workDir);
  if (videoFiles.length === 0) throw new Error('❌ لم يتم العثور على أي ملف فيديو');

  console.log(`\n📦 Discovered ${videoFiles.length} video file(s) in batch.`);
  let totalSubs = 0;
  const seenFontNames = new Set();

  // 3. Fast Single-Pass Extraction for all subtitle tracks & fonts per file
  for (let idx = 0; idx < videoFiles.length; idx++) {
    const vFile = videoFiles[idx];
    const baseName = sanitizeFilename(path.basename(vFile, path.extname(vFile)));
    console.log(`\n⚡ Processing [${idx + 1}/${videoFiles.length}]: ${baseName}`);

    let mkvInfo = null;
    try {
      const infoRaw = spawnSync('mkvmerge', ['-J', vFile], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (infoRaw.stdout) mkvInfo = JSON.parse(infoRaw.stdout);
    } catch {}

    if (mkvInfo && Array.isArray(mkvInfo.tracks)) {
      const subTracks = mkvInfo.tracks.filter((t) => t.type === 'subtitles');
      const attachments = (mkvInfo.attachments || []).filter((a) => /\.(ttf|otf|ttc|woff|woff2)$/i.test(a.file_name || ''));

      // Build single-pass mkvextract command for ALL subtitle tracks
      const trackArgs = [];
      for (const trk of subTracks) {
        const codec = (trk.codec || '').toLowerCase();
        const ext = codec.includes('subrip') || codec.includes('srt') ? 'srt' : 'ass';
        const langCode = (trk.properties?.language || trk.properties?.language_ietf || 'und').toLowerCase();
        const langFolder = LANG_MAP[langCode] || langCode.toUpperCase();
        
        const langDir = path.join(targetSubDir, langFolder);
        fs.mkdirSync(langDir, { recursive: true });

        const trackTitle = trk.properties?.track_name ? `_[${sanitizeFilename(trk.properties.track_name)}]` : '';
        const subOutFile = path.join(langDir, `${baseName}${trackTitle}.${ext}`);
        trackArgs.push(`${trk.id}:"${subOutFile}"`);
        totalSubs++;
      }

      if (trackArgs.length > 0) {
        console.log(`   📝 Extracting ${trackArgs.length} subtitle tracks in a single pass...`);
        try {
          run(`mkvextract tracks "${vFile}" ${trackArgs.join(' ')}`);
        } catch {
          // Fallback if batch mkvextract fails
          for (const arg of trackArgs) {
            try { run(`mkvextract tracks "${vFile}" ${arg}`); } catch {}
          }
        }
      }

      // Single-pass fonts extraction
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
          console.log(`   🔤 Extracting ${toExtract.length} unique fonts...`);
          try {
            run(`mkvextract attachments "${vFile}" ${toExtract.join(' ')}`);
          } catch {}
        }
      }
    } else {
      // Fallback for mp4 files
      const fallbackAss = path.join(targetSubDir, `${baseName}.ass`);
      try {
        run(`ffmpeg -y -i "${vFile}" -map 0:s:0 -c:s copy "${fallbackAss}"`);
        totalSubs++;
      } catch {}
    }
  }

  if (fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length === 0) fs.rmdirSync(fontsDir);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`\n🎉 Done! Successfully extracted ${totalSubs} subtitle files.`);
}

if (process.argv[1]?.endsWith('extract.mjs')) {
  const url = process.argv[2] || '';
  const name = process.argv[3] || 'Subtitles';
  extractSubtitles(url, name).catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  });
}