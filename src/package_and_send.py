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
    
    # Sanitize anime name for filename
    safe_name = re.sub(r'[\\/:*?"<>|]', '_', anime_name).strip() or 'Subtitles'
    
    out_dir = 'extracted_subtitles'
    if not os.path.exists(out_dir):
        print(f"❌ Error: {out_dir} directory does not exist.")
        sys.exit(1)

    print(f"\n======================================================")
    print(f"📦 Packaging Subtitles & Fonts for: {safe_name}")
    print(f"======================================================\n")

    # 1. First create bundle.zip using Python's standard zipfile / shutil
    # Clean previous temp archives
    for f in glob.glob('bundle_output*') + glob.glob('*.7z*'):
        try:
            os.remove(f)
        except:
            pass

    print("📦 Creating bundle_output.zip...")
    shutil.make_archive('bundle_output', 'zip', out_dir)
    
    zip_path = 'bundle_output.zip'
    zip_size = os.path.getsize(zip_path)
    zip_mb = zip_size / (1024 * 1024)
    print(f"📊 ZIP Archive size: {zip_size} bytes ({zip_mb:.2f} MB)")

    # Also keep a copy with the safe name for local artifacts
    shutil.copy(zip_path, f"{safe_name}.zip")

    # If no Telegram delivery requested, we are done
    if not chat_id or not token:
        print("ℹ️ Telegram delivery not requested (chat_id or token missing). Packaging completed.")
        return

    # Helper function to send document to Telegram via curl
    def send_to_telegram(local_file, display_filename, caption_text):
        print(f"📤 Uploading {display_filename} ({os.path.getsize(local_file) / (1024*1024):.2f} MB) to Telegram chat {chat_id}...")
        cmd = [
            'curl', '-s', '-S',
            '-F', f'chat_id={chat_id}',
            '-F', f'document=@{local_file};filename={display_filename}',
            '-F', 'parse_mode=Markdown',
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

    # Threshold: 45 MB (47,185,920 bytes) - safely below Telegram's 50MB limit
    MAX_FILE_BYTES = 47185920

    # Case 1: Standard ZIP is under 45 MB -> Send single universal .zip
    if zip_size <= MAX_FILE_BYTES:
        print(f"✅ Archive is under 45MB ({zip_mb:.2f} MB). Sending single universal ZIP...")
        send_to_telegram(zip_path, f"{safe_name}.zip", f"`{safe_name}.zip`")
        print("\n🎉 Packaging and delivery finished successfully!")
        return

    # Case 2: Standard ZIP exceeds 45 MB -> Try 7-Zip Ultra LZMA2 WITHOUT splitting
    print(f"⚠️ Standard ZIP ({zip_mb:.2f} MB) exceeds 45MB. Compressing with 7-Zip Ultra LZMA2...")
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

    # If 7-Zip brought it under 45MB (which happens for ~99% of cases!), send single .7z file!
    if seven_z_size <= MAX_FILE_BYTES:
        display_name = f"{safe_name}.7z"
        print(f"✅ 7-Zip Ultra compressed under 45MB ({seven_z_mb:.2f} MB). Sending single .7z file...")
        send_to_telegram(seven_z_file, display_name, f"`{display_name}`")
        print("\n🎉 Packaging and delivery finished successfully!")
        return

    # Case 3: Archive is huge even with 7-Zip Ultra -> Split into 45MB volumes
    print(f"⚠️ 7-Zip archive ({seven_z_mb:.2f} MB) still exceeds 45MB. Splitting into 45MB parts...")
    try: os.remove(seven_z_file)
    except: pass

    for f in glob.glob('bundle_output.7z*'):
        try: os.remove(f)
        except: pass

    subprocess.run(['7z', 'a', '-v45m', '-mx=9', 'bundle_output.7z', f'./{out_dir}/*'], check=True)

    parts = sorted(glob.glob('bundle_output.7z.*'))
    if not parts:
        parts = sorted(glob.glob('bundle_output.7z*'))

    total_parts = len(parts)
    print(f"📦 7-Zip created {total_parts} part(s).")

    if total_parts == 1:
        display_name = f"{safe_name}.7z"
        send_to_telegram(parts[0], display_name, f"`{display_name}`")
    else:
        print(f"📤 Sending {total_parts} split parts to Telegram...")
        for idx, part_file in enumerate(parts, 1):
            # Format: filename.7z.001, filename.7z.002 for 7-Zip compatibility
            display_name = f"{safe_name}.7z.{idx:03d}"
            caption = f"`{safe_name} - part {idx} of {total_parts}`"
            send_to_telegram(part_file, display_name, caption)
            time.sleep(1)

    print("\n🎉 Packaging and delivery finished successfully!")

if __name__ == '__main__':
    main()
