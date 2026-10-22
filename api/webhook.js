
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const CHANNELS = [
  {
    name: "KBCYBERTEAM",
    url: "https://t.me/KBCYBERTEAM"
  },
  {
    name: "IPTV Links M3U8",
    url: "https://t.me/iptvlinksm3u8"
  }
];

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Language preference is best-effort; Vercel instances can restart.
const languageByUser = new Map();

async function telegram(method, body) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

function mainKeyboard() {
  return {
    keyboard: [
      [
        { text: "🇧🇩 বাংলা" },
        { text: "🇬🇧 English" }
      ],
      [
        { text: "ℹ️ Help" },
        { text: "🤖 About" }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function channelKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "📢 Join KBCYBERTEAM",
          url: CHANNELS[0].url
        }
      ],
      [
        {
          text: "📺 Join IPTV Links M3U8",
          url: CHANNELS[1].url
        }
      ],
      [
        {
          text: "▶️ Continue to Bot",
          callback_data: "continue"
        }
      ]
    ]
  };
}

function articleKeyboard(url) {
  return {
    inline_keyboard: [
      [
        {
          text: "📖 Full Wikipedia Article",
          url
        }
      ],
      [
        {
          text: "🇧🇩 বাংলা",
          callback_data: "lang_bn"
        },
        {
          text: "🇬🇧 English",
          callback_data: "lang_en"
        }
      ]
    ]
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function wikiRequest(lang, params) {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    ...params,
    format: "json",
    utf8: "1"
  })}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "WikiSearchTelegramBot/2.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Wikipedia returned HTTP ${response.status}`);
  }

  return response.json();
}

async function wikipediaSearch(query, lang) {
  const search = await wikiRequest(lang, {
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1"
  });

  const page = search.query?.search?.[0];

  if (!page) return null;

  const data = await wikiRequest(lang, {
    action: "query",
    prop: "extracts|info|images",
    pageids: String(page.pageid),
    explaintext: "1",
    exchars: "3500",
    inprop: "url",
    imlimit: "max"
  });

  const article = data.query?.pages?.[String(page.pageid)];

  if (!article || article.missing !== undefined) {
    return null;
  }

  const imageTitles = (article.images || [])
    .map(item => item.title)
    .filter(title =>
      /\.(jpe?g|png|webp|gif)$/i.test(title || "")
    )
    .slice(0, 50);

  const imageUrls = [];

  for (let i = 0; i < imageTitles.length; i += 50) {
    const batch = imageTitles.slice(i, i + 50);

    const imageData = await wikiRequest(lang, {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      titles: batch.join("|")
    });

    for (const imagePage of Object.values(
      imageData.query?.pages || {}
    )) {
      const url = imagePage.imageinfo?.[0]?.url;

      if (url && /^https:\/\//i.test(url)) {
        imageUrls.push(url);
      }
    }
  }

  return {
    title: article.title || page.title,
    extract: article.extract || "No summary is available.",
    url: article.fullurl ||
      `https://${lang}.wikipedia.org/?curid=${page.pageid}`,
    images: [...new Set(imageUrls)].slice(0, 50)
  };
}

async function sendImageAlbums(chatId, images, title) {
  let sent = 0;

  for (let i = 0; i < images.length; i += 10) {
    const batch = images.slice(i, i + 10);

    try {
      if (batch.length === 1) {
        await telegram("sendPhoto", {
          chat_id: chatId,
          photo: batch[0],
          caption: sent === 0
            ? `📸 ${title}`.slice(0, 1000)
            : undefined
        });
      } else {
        const media = batch.map((url, index) => ({
          type: "photo",
          media: url,
          ...(sent === 0 && index === 0
            ? { caption: `📸 ${title}`.slice(0, 1000) }
            : {})
        }));

        await telegram("sendMediaGroup", {
          chat_id: chatId,
          media
        });
      }

      sent += batch.length;
    } catch (error) {
      console.error("Album failed:", error.message);

      // Fallback: try each photo individually.
      for (const url of batch) {
        try {
          await telegram("sendPhoto", {
            chat_id: chatId,
            photo: url
          });
          sent++;
        } catch (photoError) {
          console.error("Photo failed:", photoError.message);
        }
      }
    }
  }

  return sent;
}

async function showSearch(chatId, query, lang) {
  if (!query.trim()) {
    await sendMessage(
      chatId,
      lang === "bn"
        ? "🔎 যে ব্যক্তি বা বিষয় খুঁজতে চান তার নাম লিখুন।"
        : "🔎 Send the name or topic you want to search.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  await sendMessage(
    chatId,
    lang === "bn"
      ? "🔍 বাংলা Wikipedia-তে খোঁজা হচ্ছে..."
      : "🔍 Searching English Wikipedia..."
  );

  let result;

  try {
    result = await wikipediaSearch(query, lang);
  } catch (error) {
    console.error("Wikipedia search error:", error.message);

    await sendMessage(
      chatId,
      lang === "bn"
        ? "⚠️ Wikipedia থেকে তথ্য আনা যায়নি। একটু পরে আবার চেষ্টা করুন।"
        : "⚠️ Could not retrieve Wikipedia data. Please try again later.",
      { reply_markup: mainKeyboard() }
    );

    return;
  }

  if (!result) {
    await sendMessage(
      chatId,
      lang === "bn"
        ? "কোনো আর্টিকেল পাওয়া যায়নি। অন্য নামে চেষ্টা করুন অথবা English নির্বাচন করুন।"
        : "No article found. Try another name or select বাংলা.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const languageName = lang === "bn"
    ? "বাংলা Wikipedia"
    : "English Wikipedia";

  await sendMessage(
    chatId,
    `📚 <b>${escapeHtml(result.title)}</b>\n` +
      `🌐 ${languageName}\n` +
      `🖼️ ${result.images.length}টি ছবির লিংক পাওয়া গেছে।`,
    {
      parse_mode: "HTML",
      reply_markup: articleKeyboard(result.url)
    }
  );

  if (result.images.length > 0) {
    await sendImageAlbums(chatId, result.images, result.title);
  } else {
    await sendMessage(
      chatId,
      lang === "bn"
        ? "এই আর্টিকেলে সমর্থিত ছবি পাওয়া যায়নি।"
        : "No supported images were found in this article."
    );
  }

  const summary =
    `<b>${escapeHtml(result.title)}</b>\n\n` +
    escapeHtml(result.extract).slice(0, 3500);

  await sendMessage(chatId, summary.slice(0, 4000), {
    parse_mode: "HTML",
    reply_markup: articleKeyboard(result.url)
  });

  await sendMessage(
    chatId,
    lang === "bn"
      ? "আরও কিছু খুঁজতে পরের নামটি লিখুন। ভাষা বদলাতে নিচের Menu ব্যবহার করুন।"
      : "Send another topic to search. Use the menu below to change language.",
    { reply_markup: mainKeyboard() }
  );
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  const message = update.message || callback?.message;

  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const userId = update.message?.from?.id || callback?.from?.id;

  if (!userId) return;

  if (callback) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id
    }).catch(() => {});
  }

  // No getChatMember call here: membership verification is disabled.
  // Join links are provided, but actual membership is not enforced.

  if (callback) {
    if (callback.data === "continue") {
      await sendMessage(
        chatId,
        "🌐 ভাষা বেছে নিন / Choose your language:",
        { reply_markup: mainKeyboard() }
      );
      return;
    }

    if (callback.data === "lang_bn" || callback.data === "lang_en") {
      const lang = callback.data === "lang_bn" ? "bn" : "en";
      languageByUser.set(userId, lang);

      await sendMessage(
        chatId,
        lang === "bn"
          ? "🇧🇩 বাংলা নির্বাচন করা হয়েছে। এখন সার্চের নাম লিখুন।"
          : "🇬🇧 English selected. Send a name or topic.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }

    return;
  }

  const text = (message.text || "").trim();
  const command = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  const cmd = command?.[1]?.toLowerCase();

  if (cmd === "start") {
    await sendMessage(
      chatId,
      "👋 <b>Wiki Search Bot</b>\n\n" +
        "বাংলা ও English Wikipedia-তে সার্চ করুন।\n" +
        "Search Wikipedia in Bengali or English.\n\n" +
        "চ্যানেলে যোগ দিতে নিচের Link ব্যবহার করতে পারেন।",
      {
        parse_mode: "HTML",
        reply_markup: channelKeyboard()
      }
    );

    await sendMessage(
      chatId,
      "🌐 ভাষা বেছে নিন / Choose your language:",
      { reply_markup: mainKeyboard() }
    );

    return;
  }

  if (cmd === "help" || text === "ℹ️ Help") {
    await sendMessage(
      chatId,
      "📖 <b>Help / সাহায্য</b>\n\n" +
        "1. 🇧🇩 বাংলা অথবা 🇬🇧 English চাপুন।\n" +
        "2. কোনো নাম বা বিষয় লিখুন।\n" +
        "3. পাওয়া ছবি ও সারাংশ দেখুন।\n" +
        "4. Full Wikipedia Article বোতামে চাপুন।\n\n" +
        "Choose a language, send a topic, and open the full article.",
      {
        parse_mode: "HTML",
        reply_markup: mainKeyboard()
      }
    );
    return;
  }

  if (cmd === "about" || text === "🤖 About") {
    await sendMessage(
      chatId,
      "🤖 Wiki Search Bot\n\n" +
        "বাংলা ও English Wikipedia search.\n\n" +
        "📢 Channels:\n" +
        "https://t.me/KBCYBERTEAM\n" +
        "https://t.me/iptvlinksm3u8",
      {
        reply_markup: channelKeyboard()
      }
    );
    return;
  }

  if (text === "🇧🇩 বাংলা") {
    languageByUser.set(userId, "bn");

    await sendMessage(
      chatId,
      "✅ বাংলা নির্বাচন করা হয়েছে। এখন সার্চের বিষয় লিখুন।",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (text === "🇬🇧 English") {
    languageByUser.set(userId, "en");

    await sendMessage(
      chatId,
      "✅ English selected. Send a name or topic.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const lang = languageByUser.get(userId) ||
    ((message.from?.language_code || "").toLowerCase().startsWith("bn")
      ? "bn"
      : "en");

  languageByUser.set(userId, lang);

  await showSearch(chatId, text, lang);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Wiki Search Bot is running.");
  }

  if (!BOT_TOKEN || !WEBHOOK_SECRET) {
    console.error("Missing environment variables.");

    return res.status(500).json({
      ok: false,
      error: "Missing TELEGRAM_BOT_TOKEN or WEBHOOK_SECRET."
    });
  }

  if (
    req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  try {
    await handleUpdate(req.body);
  } catch (error) {
    console.error("Update processing failed:", error.message);
  }

  return res.status(200).json({ ok: true });
}
