import os
import sys
import glob
import re
import subprocess
import shutil
import time

def main():
    chat_id = os.environ.get('TELEGRAM_CHAT_ID', '').strip()
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
    anime_name = os.environ.get('ANIME_NAME', 'Subtitles').strip()
    
    # Sanitize anime name for filename (remove NTFS forbidden chars and newlines/backticks)
    safe_name = re.sub(r'[\\/:*?"<>|`\r\n]', '_', anime_name).strip() or 'Subtitles'
    safe_name = re.sub(r'_+', '_', safe_name).strip('_') or 'Subtitles'
    
    out_dir = 'extracted_subtitles'
    if not os.path.exists(out_dir):
        print(f"❌ Error: {out_dir} directory does not exist.")
        sys.exit(1)

    print(f"\n======================================================")
    print(f"📦 Packaging Subtitles & Fonts for: {safe_name}")
    print(f"======================================================\n")

    # Clean previous temp archives
    for f in glob.glob('bundle_output*') + glob.glob('*.7z*'):
        try:
            os.remove(f)
        except:
            pass

    # 1. Create bundle_output.zip using Python's standard shutil
    print("📦 Creating bundle_output.zip...")
    shutil.make_archive('bundle_output', 'zip', out_dir)
    
    zip_path = 'bundle_output.zip'
    zip_size = os.path.getsize(zip_path)
    zip_mb = zip_size / (1024 * 1024)
    print(f"📊 Standard ZIP size: {zip_size} bytes ({zip_mb:.2f} MB)")

    # Keep a copy with safe name for GitHub Actions artifacts
    try:
        shutil.copy(zip_path, f"{safe_name}.zip")
    except:
        pass

    # If no Telegram delivery requested, we are done
    if not chat_id or not token:
        print("ℹ️ Telegram delivery not requested (chat_id or token missing). Packaging completed.")
        return

    # Helper function to send document to Telegram via curl
    def send_to_telegram(local_file, display_filename, caption_text):
        size_mb = os.path.getsize(local_file) / (1024 * 1024)
        print(f"📤 Uploading {display_filename} ({size_mb:.2f} MB) to Telegram chat {chat_id}...")
        cmd = [
            'curl', '-s', '-S',
            '-F', f'chat_id={chat_id}',
            '-F', f'document=@{local_file};filename={display_filename}',
            '-F', f'caption={caption_text}',
            f'https://api.telegram.org/bot{token}/sendDocument'
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"❌ Curl failed (exit {res.returncode}): {res.stderr}")
            sys.exit(res.returncode)
        
        # Check response from Telegram API
        if '"ok":true' in res.stdout:
            print(f"✅ Telegram delivery successful for: {display_filename}")
        else:
            print(f"⚠️ Telegram API returned error: {res.stdout}")

    # Threshold: 48.5 MB (50,855,936 bytes) - safe limit under Telegram's 50MB Bot API cap
    MAX_FILE_BYTES = 50855936

    # Case 1: Standard ZIP is under 48.5 MB -> Send single universal .zip
    if zip_size <= MAX_FILE_BYTES:
        print(f"✅ Archive is under 48.5MB ({zip_mb:.2f} MB). Sending single universal ZIP...")
        send_to_telegram(zip_path, f"{safe_name}.zip", anime_name)
        print("\n🎉 Packaging and delivery finished successfully!")
        return

    # Case 2: Standard ZIP exceeds 48.5 MB -> Try 7-Zip Ultra LZMA2
    print(f"⚠️ Standard ZIP ({zip_mb:.2f} MB) exceeds 48.5MB. Compressing with 7-Zip Ultra LZMA2...")
    seven_z_file = 'bundle_output.7z'
    if os.path.exists(seven_z_file):
        try: os.remove(seven_z_file)
        except: pass

    subprocess.run(['7z', 'a', '-mx=9', seven_z_file, f'./{out_dir}/*'], check=True)
    seven_z_size = os.path.getsize(seven_z_file)
    seven_z_mb = seven_z_size / (1024 * 1024)
    print(f"📊 7-Zip Archive size: {seven_z_size} bytes ({seven_z_mb:.2f} MB)")

    # Also keep a copy for GitHub artifacts
    try:
        shutil.copy(seven_z_file, f"{safe_name}.7z")
    except:
        pass

    # If 7-Zip brought it under 48.5MB, send single .7z file!
    if seven_z_size <= MAX_FILE_BYTES:
        display_name = f"{safe_name}.7z"
        print(f"✅ 7-Zip Ultra compressed under 48.5MB ({seven_z_mb:.2f} MB). Sending single .7z file...")
        send_to_telegram(seven_z_file, display_name, anime_name)
        print("\n🎉 Packaging and delivery finished successfully!")
        return

    # Case 3: Archive is huge (> 48.5 MB even with 7-Zip)
    # Check if Fonts folder is the culprit and separate Subtitles from Fonts
    fonts_dir = os.path.join(out_dir, 'Fonts')
    has_fonts = os.path.exists(fonts_dir) and os.path.isdir(fonts_dir) and bool(os.listdir(fonts_dir))

    if has_fonts:
        print("💡 Archive exceeds 48.5MB due to Fonts. Packaging Subtitles and Fonts separately...")
        
        # 3a. Package Subtitles only (all items except Fonts) into a universal ZIP
        subs_temp_dir = 'temp_subs_only'
        if os.path.exists(subs_temp_dir):
            shutil.rmtree(subs_temp_dir)
        os.makedirs(subs_temp_dir, exist_ok=True)
        
        for item in os.listdir(out_dir):
            if item.lower() != 'fonts':
                src_path = os.path.join(out_dir, item)
                dst_path = os.path.join(subs_temp_dir, item)
                if os.path.isdir(src_path):
                    shutil.copytree(src_path, dst_path)
                else:
                    shutil.copy2(src_path, dst_path)

        subs_archive = 'bundle_subs_only'
        shutil.make_archive(subs_archive, 'zip', subs_temp_dir)
        shutil.rmtree(subs_temp_dir)
        subs_zip = f"{subs_archive}.zip"

        # Send Subtitles first (always universal .zip)
        send_to_telegram(subs_zip, f"{safe_name} - Subtitles.zip", f"🎬 {anime_name} - الترجمات")
        time.sleep(1)

        # 3b. Package Fonts separately using 7-Zip Ultra
        fonts_7z = 'bundle_fonts.7z'
        if os.path.exists(fonts_7z):
            try: os.remove(fonts_7z)
            except: pass

        subprocess.run(['7z', 'a', '-mx=9', fonts_7z, f'./{fonts_dir}/*'], check=True)
        fonts_size = os.path.getsize(fonts_7z)
        fonts_mb = fonts_size / (1024 * 1024)
        print(f"📊 Fonts 7-Zip size: {fonts_size} bytes ({fonts_mb:.2f} MB)")

        if fonts_size <= MAX_FILE_BYTES:
            send_to_telegram(fonts_7z, f"{safe_name} - Fonts.7z", f"🔤 {anime_name} - الخطوط")
        else:
            # If Fonts alone exceeds 48.5 MB, split only the fonts!
            print(f"⚠️ Fonts archive exceeds 48.5MB. Splitting fonts into 48MB parts...")
            for f in glob.glob('bundle_fonts.7z*'):
                try: os.remove(f)
                except: pass
            subprocess.run(['7z', 'a', '-v48m', '-mx=9', 'bundle_fonts.7z', f'./{fonts_dir}/*'], check=True)
            font_parts = sorted(glob.glob('bundle_fonts.7z.*'))
            if not font_parts:
                font_parts = sorted(glob.glob('bundle_fonts.7z*'))
            
            for idx, part_file in enumerate(font_parts, 1):
                display_name = f"{safe_name} - Fonts.7z.{idx:03d}"
                caption = f"🔤 {anime_name} - الخطوط (جزء {idx} من {len(font_parts)})"
                send_to_telegram(part_file, display_name, caption)
                time.sleep(1)

        print("\n🎉 Packaging and delivery finished successfully!")
        return

    # Fallback Case 4: No separate Fonts folder, but archive > 48.5 MB -> Split into 48MB volumes
    print(f"⚠️ Splitting archive into 48MB parts...")
    try: os.remove(seven_z_file)
    except: pass

    for f in glob.glob('bundle_output.7z*'):
        try: os.remove(f)
        except: pass

    subprocess.run(['7z', 'a', '-v48m', '-mx=9', 'bundle_output.7z', f'./{out_dir}/*'], check=True)

    parts = sorted(glob.glob('bundle_output.7z.*'))
    if not parts:
        parts = sorted(glob.glob('bundle_output.7z*'))

    total_parts = len(parts)
    print(f"📦 7-Zip created {total_parts} part(s).")

    if total_parts == 1:
        display_name = f"{safe_name}.7z"
        send_to_telegram(parts[0], display_name, anime_name)
    else:
        print(f"📤 Sending {total_parts} split parts to Telegram...")
        for idx, part_file in enumerate(parts, 1):
            display_name = f"{safe_name}.7z.{idx:03d}"
            caption = f"{anime_name} - part {idx} of {total_parts}"
            send_to_telegram(part_file, display_name, caption)
            time.sleep(1)

    print("\n🎉 Packaging and delivery finished successfully!")

if __name__ == '__main__':
    main()
