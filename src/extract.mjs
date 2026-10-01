import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { File as MegaFile } from 'megajs';

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

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
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

async function resolveDdlDirectoryLinks(dirUrl) {
  console.log(`🔍 Scanning DDL directory listing: ${dirUrl}...`);
  try {
    const parsed = new URL(dirUrl);
    const res = await fetch(dirUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return [];
    const html = await res.text();

    const found = new Set();
    // 1. Match Directory Lister dl.php links
    const dlRegex = /href=["']([^"']*dl\.php\?file=[^"']+)["']/gi;
    let m;
    while ((m = dlRegex.exec(html)) !== null) {
      let link = m[1].replace(/&amp;/g, '&');
      if (!link.startsWith('http')) {
        link = new URL(link, parsed.origin).href;
      }
      found.add(link);
    }

    // 2. Match direct file links (.mkv, .mp4, .avi, .rar, .zip, .7z)
    const directRegex = /href=["']([^"']+\.(?:mkv|mp4|avi|webm|rar|zip|7z|tar))["']/gi;
    while ((m = directRegex.exec(html)) !== null) {
      let link = m[1].replace(/&amp;/g, '&');
      if (!link.startsWith('http')) {
        link = new URL(link, parsed.origin).href;
      }
      found.add(link);
    }

    const results = Array.from(found);
    console.log(`📁 Found ${results.length} downloadable file link(s) in DDL directory.`);
    return results;
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to parse DDL directory: ${err.message}`);
    return [];
  }
}

function convertMegaUrlForMegatools(url) {
  let u = url.trim();
  const folderMatch = u.match(/mega\.nz\/folder\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/i);
  if (folderMatch) {
    return `https://mega.nz/#F!${folderMatch[1]}!${folderMatch[2]}`;
  }
  const fileMatch = u.match(/mega\.nz\/file\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/i);
  if (fileMatch) {
    return `https://mega.nz/#!${fileMatch[1]}!${fileMatch[2]}`;
  }
  return u;
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

/**
 * Processes all archives, subtitles, fonts, and videos currently inside workDir.
 * Extracts tracks & attachments into targetSubDir and fontsDir.
 * Removes processed videos and archives to keep disk usage minimal.
 */
function processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames) {
  // 1. Unpack any archives (.rar, .zip, .7z, etc.)
  extractArchivesRecursively(workDir);

  let extractedCount = 0;

  // 2. Discover standalone font files
  const standaloneFonts = findAllFontFiles(workDir);
  if (standaloneFonts.length > 0) {
    console.log(`🔤 Found ${standaloneFonts.length} font file(s) in source/archive.`);
    for (const fFile of standaloneFonts) {
      const fBase = path.basename(fFile);
      if (!seenFontNames.has(fBase.toLowerCase())) {
        seenFontNames.add(fBase.toLowerCase());
        fs.copyFileSync(fFile, path.join(fontsDir, fBase));
      }
      try { fs.rmSync(fFile, { force: true }); } catch {}
    }
  }

  // 3. Discover standalone subtitle files
  const standaloneSubs = findAllSubtitleFiles(workDir);
  if (standaloneSubs.length > 0) {
    console.log(`📝 Found ${standaloneSubs.length} standalone subtitle file(s) in source/archive.`);
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
      extractedCount++;
      try { fs.rmSync(sFile, { force: true }); } catch {}
    }
  }

  // 4. Discover all video files
  const videoFiles = findAllVideoFiles(workDir);
  for (let idx = 0; idx < videoFiles.length; idx++) {
    const vFile = videoFiles[idx];
    const baseName = sanitizeFilename(path.basename(vFile, path.extname(vFile)));
    console.log(`⚡ Processing video: ${baseName}`);

    let mkvInfo = null;
    try {
      const infoRaw = spawnSync('mkvmerge', ['-J', vFile], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (infoRaw.stdout) mkvInfo = JSON.parse(infoRaw.stdout);
    } catch {}

    if (mkvInfo && Array.isArray(mkvInfo.tracks)) {
      const subTracks = mkvInfo.tracks.filter((t) => t.type === 'subtitles');
      const attachments = (mkvInfo.attachments || []).filter((a) => /\.(ttf|otf|ttc|woff|woff2)$/i.test(a.file_name || ''));

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
        extractedCount++;
      }

      if (trackArgs.length > 0) {
        console.log(`   📝 Extracting ${trackArgs.length} subtitle track(s)...`);
        try {
          run(`mkvextract tracks "${vFile}" ${trackArgs.join(' ')}`);
        } catch {
          for (const arg of trackArgs) {
            try { run(`mkvextract tracks "${vFile}" ${arg}`); } catch {}
          }
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
          console.log(`   🔤 Extracting ${toExtract.length} unique font(s)...`);
          try {
            run(`mkvextract attachments "${vFile}" ${toExtract.join(' ')}`);
          } catch {}
        }
      }
    } else {
      // Fallback for non-MKV (e.g. mp4)
      const fallbackAss = path.join(targetSubDir, `${baseName}.ass`);
      try {
        run(`ffmpeg -y -i "${vFile}" -map 0:s:0 -c:s copy "${fallbackAss}"`);
        extractedCount++;
      } catch {}
    }

    // Immediately remove large video file to conserve disk space
    try { fs.rmSync(vFile, { force: true }); } catch {}
  }

  return extractedCount;
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

  let totalSubs = 0;
  const seenFontNames = new Set();

  const isGdrive = inputUrl.includes('drive.google.com') || inputUrl.includes('drive.usercontent.google.com');
  const gdriveId = isGdrive ? extractGoogleDriveId(inputUrl) : null;
  const isDdlDir = inputUrl.includes('?dir=') || inputUrl.includes('&dir=') || (inputUrl.includes('ddl.') && !inputUrl.includes('dl.php?file='));

  // 1. DDL Directory (Multiple files batch)
  if (isDdlDir) {
    const ddlLinks = await resolveDdlDirectoryLinks(inputUrl);
    if (ddlLinks.length > 0) {
      console.log(`\n📁 Processing DDL directory batch (${ddlLinks.length} files)...`);
      for (let i = 0; i < ddlLinks.length; i++) {
        const fileUrl = ddlLinks[i];
        console.log(`\n⬇️ [${i + 1}/${ddlLinks.length}] Downloading DDL file: ${fileUrl}`);
        try {
          run(`aria2c --dir="${workDir}" --content-disposition=true --file-allocation=none --enable-mmap=true --check-certificate=false --header="User-Agent: Mozilla/5.0" --header="Referer: ${inputUrl}" --max-connection-per-server=16 --split=16 "${fileUrl}"`);
          const extracted = processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
          totalSubs += extracted;
        } catch (err) {
          console.warn(`⚠️ Error processing DDL item [${i + 1}]: ${err.message}`);
        }
      }
    }
  }
  // 2. MEGA (Folder or File)
  else if (inputUrl.includes('mega.nz')) {
    console.log(`☁️ Processing MEGA link...`);
    let megaSuccess = false;

    // A. First Attempt: megatools dl (High-speed multi-threaded C binary with native AES acceleration)
    const convertedUrl = convertMegaUrlForMegatools(inputUrl);
    try {
      console.log(`🚀 Attempting high-speed megatools download: ${convertedUrl}`);
      run(`megatools dl --path "${workDir}" --no-progress "${convertedUrl}"`);
      const extracted = processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
      totalSubs += extracted;
      megaSuccess = true;
      console.log(`✅ High-speed megatools download completed successfully!`);
    } catch (mtErr) {
      console.warn(`⚠️ megatools dl did not succeed (${mtErr.message}). Falling back to megajs streaming...`);
    }

    // B. Second Attempt: megajs (Pure Node.js streaming fallback)
    if (!megaSuccess) {
      try {
        const megaFile = MegaFile.fromURL(inputUrl);
        await megaFile.loadAttributes();

        function getAllMegaFiles(node) {
          const files = [];
          if (!node) return files;
          if (!node.directory) {
            files.push(node);
            return files;
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              files.push(...getAllMegaFiles(child));
            }
          }
          return files;
        }

        if (megaFile.directory) {
          const allFiles = getAllMegaFiles(megaFile);
          console.log(`📂 MEGA folder detected: "${megaFile.name}" with ${allFiles.length} file(s)`);
          for (let i = 0; i < allFiles.length; i++) {
            const child = allFiles[i];
            const safeName = sanitizeFilename(child.name);
            const outPath = path.join(workDir, safeName);
            console.log(`\n⬇️ [${i + 1}/${allFiles.length}] Downloading MEGA file: ${safeName} (${(child.size / (1024 * 1024)).toFixed(1)} MB)...`);
            const stream = child.download();
            const writeStream = fs.createWriteStream(outPath);
            await pipeline(stream, writeStream);
            console.log(`✅ Downloaded: ${safeName}`);

            const extracted = processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
            totalSubs += extracted;
          }
          megaSuccess = true;
        } else {
          const safeName = sanitizeFilename(megaFile.name);
          const outPath = path.join(workDir, safeName);
          console.log(`⬇️ Downloading single MEGA file: ${safeName} (${(megaFile.size / (1024 * 1024)).toFixed(1)} MB)...`);
          const stream = megaFile.download();
          const writeStream = fs.createWriteStream(outPath);
          await pipeline(stream, writeStream);
          console.log(`✅ Downloaded: ${safeName}`);

          const extracted = processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
          totalSubs += extracted;
          megaSuccess = true;
        }
      } catch (megaErr) {
        console.warn(`⚠️ megajs encountered an issue: ${megaErr.message}. Attempting python fallback...`);
      }
    }

    // C. Third Attempt: python mega.py fallback
    if (!megaSuccess) {
      try {
        run(`python3 -c "from mega import Mega; m = Mega(); m.login(); m.download_url('${inputUrl}', '${workDir}')"`);
        const extracted = processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
        totalSubs += extracted;
      } catch (pyErr) {
        console.error(`❌ All MEGA download methods failed: ${pyErr.message}`);
        throw pyErr;
      }
    }
  }
  // 3. Torrents & Magnet Links
  else if (inputUrl.startsWith('magnet:') || inputUrl.includes('.torrent') || inputUrl.includes('nyaa.si') || inputUrl.includes('acg.rip')) {
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
    totalSubs += processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
  }
  // 4. Google Drive
  else if (isGdrive) {
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
    totalSubs += processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
  }
  // 5. Mediafire
  else if (inputUrl.includes('mediafire.com')) {
    const directMf = await resolveMediafireDirectUrl(inputUrl);
    run(`aria2c --dir="${workDir}" --content-disposition=true --file-allocation=none --enable-mmap=true --check-certificate=false --header="User-Agent: Mozilla/5.0" --max-connection-per-server=16 --split=16 "${directMf}"`);
    totalSubs += processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
  }
  // 6. Direct HTTP / Pixeldrain / MiteDrive / DDL single file
  else if (inputUrl.startsWith('http')) {
    run(`aria2c --dir="${workDir}" --content-disposition=true --file-allocation=none --enable-mmap=true --check-certificate=false --header="User-Agent: Mozilla/5.0" --max-connection-per-server=16 --split=16 "${inputUrl}"`);
    totalSubs += processWorkDirFiles(workDir, targetSubDir, fontsDir, seenFontNames);
  }

  // Final check
  const allResultSubs = findAllSubtitleFiles(targetSubDir);
  if (allResultSubs.length === 0 && totalSubs === 0) {
    throw new Error('❌ لم يتم العثور على أي ملفات ترجمة أو فيديو صالح');
  }

  if (fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length === 0) {
    try { fs.rmdirSync(fontsDir); } catch {}
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

  console.log(`\n🎉 Done! Successfully extracted ${allResultSubs.length || totalSubs} subtitle files.`);
}

if (process.argv[1]?.endsWith('extract.mjs')) {
  const url = process.argv[2] || '';
  const name = process.argv[3] || 'Subtitles';
  extractSubtitles(url, name).catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  });
}