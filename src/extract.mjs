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

const PUBLIC_TRACKERS = [
  'http://tr.bangumi.moe:6969/announce',
  'http://open.acg-gov.com:8001/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce'
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function extractGoogleDriveId(url) {
  const m = url.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)|drive\.usercontent\.google\.com\/download\?id=)([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}

async function resolveMitedriveDirectUrl(url) {
  const match = url.match(/mitedrive\.com\/(?:download|view|files)\/([a-zA-Z0-9_-]+)/i) ||
                url.match(/api\.mitedrive\.com\/api\/view\/([a-zA-Z0-9_-]+)/i);
  if (!match) return url;
  const slug = match[1];
  console.log(`🔍 Resolving MiteDrive direct download link for slug: ${slug}...`);
  try {
    const res = await fetch(`https://api.mitedrive.com/api/view/${slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://mitedrive.com/download/${slug}`,
        'Origin': 'https://mitedrive.com'
      },
      body: JSON.stringify({})
    });
    if (res.ok) {
      const json = await res.json();
      if (json.success && json.data?.original_url) {
        console.log(`🔗 Successfully resolved MiteDrive URL: ${json.data.original_url}`);
        return json.data.original_url;
      }
    }
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to resolve MiteDrive API: ${err.message}`);
  }
  return url;
}

async function normalizeUrl(rawUrl) {
  let u = rawUrl.trim();

  // Pixeldrain
  const pixeldrainMatch = u.match(/^https?:\/\/(?:www\.)?pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
  if (pixeldrainMatch) {
    return `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}?download`;
  }

  // MiteDrive
  if (u.includes('mitedrive.com')) {
    return await resolveMitedriveDirectUrl(u);
  }

  // Nyaa & Sukebei
  const nyaaMatch = u.match(/^https?:\/\/(?:www\.)?nyaa\.si\/view\/(\d+)/i);
  if (nyaaMatch) return `https://nyaa.si/download/${nyaaMatch[1]}.torrent`;
  const sukebeiMatch = u.match(/^https?:\/\/(?:www\.)?sukebei\.nyaa\.si\/view\/(\d+)/i);
  if (sukebeiMatch) return `https://sukebei.nyaa.si/download/${sukebeiMatch[1]}.torrent`;

  // ACG.RIP
  const acgRipMatch = u.match(/^https?:\/\/(?:www\.)?acg\.rip\/t\/(\d+)/i);
  if (acgRipMatch) return `https://acg.rip/t/${acgRipMatch[1]}.torrent`;

  // ACGNX (Share.acgnx.se / net)
  const acgnxMatch = u.match(/^https?:\/\/(?:www\.)?(?:share\.)?acgnx\.(?:se|net)\/(?:show|down)-([a-f0-9]{40})/i);
  if (acgnxMatch) return `magnet:?xt=urn:btih:${acgnxMatch[1]}${PUBLIC_TRACKERS}`;

  // Bangumi.moe
  const bangumiMatch = u.match(/^https?:\/\/(?:www\.)?bangumi\.moe\/torrent\/([a-f0-9]{24})/i);
  if (bangumiMatch) {
    try {
      const res = await fetch(`https://bangumi.moe/api/v2/torrent/${bangumiMatch[1]}`);
      if (res.ok) {
        const data = await res.json();
        if (data.magnet) {
          return data.magnet.includes('&tr=') ? data.magnet : `${data.magnet}${PUBLIC_TRACKERS}`;
        }
        if (data.infoHash) {
          return `magnet:?xt=urn:btih:${data.infoHash}${PUBLIC_TRACKERS}`;
        }
      }
    } catch (err) {
      console.warn('⚠️ Warning: Failed to resolve Bangumi.moe API, falling back to original URL.');
    }
  }

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

function extractArchivesRecursively(dir) {
  const archiveExts = ['.rar', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'];
  let anyUnpacked = false;

  function findArchives(d) {
    const found = [];
    if (!fs.existsSync(d)) return found;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        found.push(...findArchives(full));
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (archiveExts.some(ext => lower.endsWith(ext))) {
          found.push(full);
        }
      }
    }
    return found;
  }

  for (let pass = 1; pass <= 5; pass++) {
    const archives = findArchives(dir);
    if (archives.length === 0) break;
    anyUnpacked = true;

    for (const arch of archives) {
      const targetDir = path.dirname(arch);
      console.log(`📦 Unpacking archive: ${path.basename(arch)}...`);
      let success = false;

      // 1. Try 7z (supported via 7zip / p7zip-full, handles RAR5/7z/ZIP/TAR)
      try {
        run(`7z x -y -p"" -o"${targetDir}" "${arch}"`);
        success = true;
      } catch {}

      // 2. Try unar
      if (!success) {
        try {
          run(`unar -quiet -o "${targetDir}" "${arch}"`);
          success = true;
        } catch {}
      }

      // 3. Try tar (built-in on Windows & Linux)
      if (!success) {
        try {
          run(`tar -xf "${arch}" -C "${targetDir}"`);
          success = true;
        } catch {}
      }

      // 4. Try unzip or unrar
      if (!success) {
        const lower = arch.toLowerCase();
        if (lower.endsWith('.zip')) {
          try { run(`unzip -o -d "${targetDir}" "${arch}"`); success = true; } catch {}
        } else if (lower.endsWith('.rar')) {
          try { run(`unrar x -o+ "${arch}" "${targetDir}"`); success = true; } catch {}
        }
      }

      if (success) {
        fs.rmSync(arch, { force: true });
      } else {
        console.warn(`⚠️ Warning: Could not unpack archive: ${path.basename(arch)}`);
      }
    }
  }
  return anyUnpacked;
}

function findAllSubtitleFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllSubtitleFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.ass', '.srt', '.vtt', '.sup'].includes(ext)) results.push(fullPath);
    }
  }
  return results;
}

function findAllFontFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllFontFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.ttf', '.otf', '.ttc', '.woff', '.woff2'].includes(ext)) results.push(fullPath);
    }
  }
  return results;
}

export async function extractSubtitles(rawUrl, outputName) {
  let inputUrl = await normalizeUrl(rawUrl);
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const workDir = path.resolve('temp_work');
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const safeBundleName = sanitizeFilename(outputName || 'Subtitles_Batch');
  const targetSubDir = OUT_DIR;
  const fontsDir = path.join(targetSubDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Turbo Extraction: ${safeBundleName}`);
  console.log(`🔗 Input URL: ${inputUrl}`);
  console.log(`======================================================\n`);

  const isGdrive = inputUrl.includes('drive.google.com') || inputUrl.includes('drive.usercontent.google.com');
  const gdriveId = isGdrive ? extractGoogleDriveId(inputUrl) : null;

  // 1. Download source files with maximum multi-threading & memory mapping
  if (inputUrl.startsWith('magnet:') || inputUrl.includes('.torrent') || inputUrl.includes('nyaa.si') || inputUrl.includes('acg.rip')) {
    const ariaArgs = [
      '--seed-time=0',
      '--summary-interval=5',
      '--file-allocation=none',
      '--enable-mmap=true',
      '--check-certificate=false',
      '--content-disposition=true',
      '--user-agent="Mozilla/5.0"',
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
  } else if (isGdrive) {
    if (inputUrl.includes('/folders/')) {
      run(`gdown "${inputUrl}" -O "${workDir}/" --folder --fuzzy`);
    } else if (gdriveId) {
      try {
        run(`gdown --id "${gdriveId}" -O "${workDir}/" --fuzzy`);
      } catch (err) {
        console.warn('⚠️ Warning: gdown direct download failed, attempting aria2c fallback with confirm=t...');
        const directGdrive = `https://drive.usercontent.google.com/download?id=${gdriveId}&export=download&confirm=t`;
        run(`aria2c --dir="${workDir}" --content-disposition=true --check-certificate=false --header="User-Agent: Mozilla/5.0" "${directGdrive}"`);
      }
    } else {
      run(`gdown "${inputUrl}" -O "${workDir}/" --fuzzy`);
    }
  } else if (inputUrl.includes('mediafire.com')) {
    const directMf = await resolveMediafireDirectUrl(inputUrl);
    run(`aria2c --dir="${workDir}" --content-disposition=true --file-allocation=none --enable-mmap=true --check-certificate=false --header="User-Agent: Mozilla/5.0" --max-connection-per-server=16 --split=16 "${directMf}"`);
  } else if (inputUrl.includes('mega.nz')) {
    try {
      run(`megatools dl --path "${workDir}" "${inputUrl}"`);
    } catch {
      run(`python3 -c "from mega import Mega; m = Mega(); m.login(); m.download_url('${inputUrl}', '${workDir}')"`);
    }
  } else if (inputUrl.startsWith('http')) {
    run(`aria2c --dir="${workDir}" --content-disposition=true --file-allocation=none --enable-mmap=true --check-certificate=false --header="User-Agent: Mozilla/5.0" --max-connection-per-server=16 --split=16 "${inputUrl}"`);
  }

  // 2. Unpack any archives (.rar, .zip, .7z, etc.)
  extractArchivesRecursively(workDir);

  let totalSubs = 0;
  const seenFontNames = new Set();

  // 3. Discover standalone subtitle files and fonts extracted from archives
  const standaloneSubs = findAllSubtitleFiles(workDir);
  const standaloneFonts = findAllFontFiles(workDir);

  if (standaloneFonts.length > 0) {
    console.log(`\n🔤 Found ${standaloneFonts.length} font file(s) in source/archive. Copying to fonts directory...`);
    for (const fFile of standaloneFonts) {
      const fBase = path.basename(fFile);
      if (!seenFontNames.has(fBase.toLowerCase())) {
        seenFontNames.add(fBase.toLowerCase());
        fs.copyFileSync(fFile, path.join(fontsDir, fBase));
      }
    }
  }

  if (standaloneSubs.length > 0) {
    console.log(`\n📝 Found ${standaloneSubs.length} standalone subtitle file(s) in source/archive.`);
    for (const sFile of standaloneSubs) {
      const sBase = path.basename(sFile);
      let detectedLang = 'Other';
      const lower = sBase.toLowerCase();
      for (const [code, lang] of Object.entries(LANG_MAP)) {
        if (new RegExp(`[._\\[\\(-]${code}[._\\]\\)-]`, 'i').test(lower)) {
          detectedLang = lang;
          break;
        }
      }
      const langDir = path.join(targetSubDir, detectedLang);
      fs.mkdirSync(langDir, { recursive: true });
      fs.copyFileSync(sFile, path.join(langDir, sBase));
      totalSubs++;
    }
  }

  // 4. Discover all video files
  const videoFiles = findAllVideoFiles(workDir);
  if (videoFiles.length === 0 && standaloneSubs.length === 0) {
    throw new Error('❌ لم يتم العثور على أي ملف فيديو أو ملفات ترجمة');
  }

  console.log(`\n📦 Discovered ${videoFiles.length} video file(s) in batch.`);

  // 5. Fast Single-Pass Extraction for all subtitle tracks & fonts per video file
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