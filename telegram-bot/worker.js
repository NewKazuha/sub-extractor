/**
 * Cloudflare Worker for Telegram Subtitle Extractor Bot
 * 
 * Environment Variables required in Cloudflare Worker settings:
 * - TELEGRAM_BOT_TOKEN: The token from @BotFather
 * - GITHUB_PAT: GitHub Personal Access Token (classic with 'repo' scope or fine-grained with 'Actions: Read and write')
 * - GITHUB_OWNER: GitHub username or organization (e.g. 'NewKazuha')
 * - GITHUB_REPO: Repository name (e.g. 'sub-extractor')
 * - ALLOWED_CHAT_ID: (Optional) Your Telegram user ID or chat ID to restrict usage to you only
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health check & Webhook helper
    if (request.method === 'GET') {
      if (url.pathname === '/set-webhook') {
        const webhookUrl = `${url.origin}/`;
        const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
        const data = await tgRes.json();
        return new Response(JSON.stringify(data, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        status: 'online',
        service: 'Telegram Subtitle Extractor Worker',
        repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Handle Telegram Webhook POST
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        if (update && update.message && update.message.text) {
          ctx.waitUntil(handleTelegramMessage(update.message, env));
        }
      } catch (err) {
        console.error('Error handling Telegram update:', err);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
};

async function handleTelegramMessage(message, env) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  // Security check: restrict to allowed user(s) if configured
  if (env.ALLOWED_CHAT_ID) {
    const allowedList = String(env.ALLOWED_CHAT_ID).split(',').map(id => id.trim());
    if (!allowedList.includes(String(chatId))) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '⛔ عذراً، هذا البوت خاص وغير متاح للاستخدام العام.');
      return;
    }
  }

  // Handle /start or /help
  if (text === '/start' || text === '/help') {
    const helpMsg = `🎬 *مرحباً بك في بوت استخراج الترجمات والخطوط!*

أرسل لي الرابط وتحته اسم العمل، وسيقوم البوت بتشغيل خوادم GitHub لتحميله واستخراج الترجمات والخطوط وإرسالها لك في ملف مضغوط مباشرة هنا!

📌 *المواقع والروابط المدعومة:*
• مجلدات وملفات MEGA (\`mega.nz/folder/...\` أو \`file\`)
• فهارس وروابط DDL (\`ddl.3asq.com\` ومواقع الفهارس)
• Google Drive (ملفات ومجلدات)
• Pixeldrain & MiteDrive
• Mediafire
• روابط التورنت والماجنت (Nyaa، إلخ)

💡 *كيفية الاستخدام:*
أرسل الرابط، وضع اسم العمل في السطر التالي، مثال:
\`https://...\`
\`اسم العمل\``;
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg, 'Markdown');
    return;
  }

  // Extract URL from message
  const urlMatch = text.match(/(https?:\/\/[^\s]+|magnet:\?[^\s]+)/i);
  if (!urlMatch) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '⚠️ لم يتم العثور على رابط صالح.\nيرجى إرسال رابط تحميل صالح (MEGA, DDL, Drive, Torrent, إلخ).');
    return;
  }

  const targetUrl = urlMatch[0];
  // Extract anime name after removing the URL
  let animeName = text.replace(targetUrl, '').replace(/^\/extract\s*/i, '').trim();
  if (!animeName) {
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `⚠️ *يرجى إرسال اسم العمل تحت الرابط!*\n\nمثال:\n\`${targetUrl}\`\n\`اسم العمل\``,
      'Markdown'
    );
    return;
  }

  // Send acknowledgement message to Telegram
  await sendTelegramMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `⏳ *تم استلام الطلب بنجاح!*
📌 *العمل:* \`${animeName}\`
🔗 *الرابط:* \`${targetUrl.substring(0, 60)}${targetUrl.length > 60 ? '...' : ''}\`

🚀 بدأت خوادم GitHub Actions في تنزيل واستخراج الترجمات والخطوط، وسيتم إرسال الملف إليك هنا فور الانتهاء!`,
    'Markdown'
  );

  // Trigger GitHub Actions Workflow
  try {
    const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/extract.yml/dispatches`;
    const ghRes = await fetch(ghUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Cloudflare-Worker-Telegram-Bot',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          url: targetUrl,
          name: animeName,
          chat_id: String(chatId)
        }
      })
    });

    if (ghRes.status === 204) {
      console.log(`Successfully dispatched GitHub workflow for chat ${chatId}`);
    } else {
      const errBody = await ghRes.text();
      console.error(`GitHub API error (${ghRes.status}):`, errBody);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `❌ حدث خطأ أثناء تشغيل سيرفرات GitHub (${ghRes.status}):\n\`${errBody}\`\nتأكد من صلاحيات الـ GITHUB_PAT وإعدادات المستودع.`,
        'Markdown'
      );
    }
  } catch (err) {
    console.error('Failed to trigger GitHub Action:', err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `❌ تعذر الاتصال بـ GitHub:\n${err.message}`
    );
  }
}

async function sendTelegramMessage(token, chatId, text, parseMode = null) {
  try {
    const body = {
      chat_id: chatId,
      text: text
    };
    if (parseMode) body.parse_mode = parseMode;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Failed to send Telegram message:', e);
  }
}
