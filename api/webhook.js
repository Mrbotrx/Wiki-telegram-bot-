
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const CHANNELS = [
  { username: "@KBCYBERTEAM", url: "https://t.me/KBCYBERTEAM" },
  { username: "@iptvlinksm3u8", url: "https://t.me/iptvlinksm3u8" }
];

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Vercel serverless instances may restart, so this is best-effort only.
const languageByUser = new Map();

async function telegram(method, body) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `${method} failed`);
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
      [{ text: "🇧🇩 বাংলা" }, { text: "🇬🇧 English" }],
      [{ text: "ℹ️ Help" }, { text: "🤖 About" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function joinKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Join KBCYBERTEAM", url: CHANNELS[0].url }],
      [{ text: "📺 Join IPTV Links M3U8", url: CHANNELS[1].url }],
      [{ text: "✅ Joined — Verify", callback_data: "verify_join" }]
    ]
  };
}

function articleKeyboard(url) {
  return {
    inline_keyboard: [
      [{ text: "📖 Full Wikipedia Article", url }],
      [
        { text: "🇧🇩 বাংলা", callback_data: "lang_bn" },
        { text: "🇬🇧 English", callback_data: "lang_en" }
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

async function checkMembership(userId) {
  for (const channel of CHANNELS) {
    const member = await telegram("getChatMember", {
      chat_id: channel.username,
      user_id: userId
    });

    const joined =
      ["creator", "administrator", "member"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);

    if (!joined) return false;
  }

  return true;
}

async function wikiRequest(lang, params) {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    ...params,
    format: "json",
    utf8: "1"
  })}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "WikiSearchTelegramBot/2.0 (Wikipedia API client)"
    }
  });

  if (!response.ok) {
    throw new Error(`Wikipedia HTTP ${response.status}`);
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
  if (!article || article.missing !== undefined) return null;

  // Collect image titles attached to this Wikipedia article.
  const imageTitles = (article.images || [])
    .map(item => item.title)
    .filter(title => /\.(jpe?g|png|webp|gif)$/i.test(title || ""))
    .slice(0, 50);

  let imageUrls = [];

  // Query image URLs in batches to stay within API limits.
  for (let i = 0; i < imageTitles.length; i += 50) {
    const batch = imageTitles.slice(i, i + 50);

    const imageData = await wikiRequest(lang, {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      titles: batch.join("|")
    });

    for (const item of Object.values(imageData.query?.pages || {})) {
      const imageUrl = item.imageinfo?.[0]?.url;
      if (imageUrl && /^https:\/\//i.test(imageUrl)) {
        imageUrls.push(imageUrl);
      }
    }
  }

  imageUrls = [...new Set(imageUrls)].slice(0, 50);

  return {
    title: article.title || page.title,
    extract: article.extract || "No summary available.",
    url: article.fullurl ||
      `https://${lang}.wikipedia.org/?curid=${page.pageid}`,
    images: imageUrls
  };
}

async function sendImageAlbums(chatId, images, title) {
  let sent = 0;

  // Telegram media groups accept 2–10 photos per album.
  for (let i = 0; i < images.length; i += 10) {
    const batch = images.slice(i, i + 10);

    try {
      if (batch.length === 1) {
        await telegram("sendPhoto", {
          chat_id: chatId,
          photo: batch[0],
          caption: sent === 0 ? `📸 ${title}` : undefined
        });
      } else {
        await telegram("sendMediaGroup", {
          chat_id: chatId,
          media: batch.map((url, index) => ({
            type: "photo",
            media: url,
            ...(sent === 0 && index === 0
              ? { caption: `📸 ${title}` }
              : {})
          }))
        });
      }

      sent += batch.length;
    } catch (error) {
      console.error("Image album failed:", error.message);

      // Try individual images if an album fails.
      for (const url of batch) {
        try {
          await telegram("sendPhoto", {
            chat_id: chatId,
            photo: url
          });
          sent++;
        } catch (photoError) {
          console.error("Image failed:", photoError.message);
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
        ? "🔎 যে বিষয় খুঁজতে চান তার নাম লিখুন।"
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
    console.error("Wikipedia error:", error.message);
    await sendMessage(
      chatId,
      "⚠️ Wikipedia থেকে তথ্য পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।"
    );
    return;
  }

  if (!result) {
    await sendMessage(
      chatId,
      lang === "bn"
        ? "এই ভাষায় কোনো আর্টিকেল পাওয়া যায়নি। English বোতাম দিয়ে চেষ্টা করুন।"
        : "No article found. Try the বাংলা button.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const languageName = lang === "bn" ? "বাংলা Wikipedia" : "English Wikipedia";

  await sendMessage(
    chatId,
    `📚 <b>${escapeHtml(result.title)}</b>\n` +
      `🌐 ${languageName}\n\n` +
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
        ? "এই আর্টিকেলে উপযুক্ত ছবি পাওয়া যায়নি।"
        : "No supported images were found for this article."
    );
  }

  await sendMessage(
    chatId,
    `<b>${escapeHtml(result.title)}</b>\n\n` +
      escapeHtml(result.extract).slice(0, 3500),
    {
      parse_mode: "HTML",
      reply_markup: articleKeyboard(result.url)
    }
  );

  await sendMessage(
    chatId,
    lang === "bn"
      ? "আরও কিছু খুঁজতে পরের নামটি লিখুন। নিচে ভাষা পরিবর্তন করতে পারবেন।"
      : "Send another topic to search. You can change language below.",
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

  let joined;

  try {
    joined = await checkMembership(userId);
  } catch (error) {
    console.error("Membership check failed:", error.message);
    await sendMessage(
      chatId,
      "⚠️ Membership যাচাই করা যাচ্ছে না। বটকে দুই চ্যানেলেই Admin করুন।"
    );
    return;
  }

  if (!joined) {
    await sendMessage(
      chatId,
      "🔒 বট ব্যবহার করতে দুই চ্যানেলেই Join করুন।\n" +
        "Join BOTH channels to use this bot.",
      { reply_markup: joinKeyboard() }
    );
    return;
  }

  if (callback) {
    if (callback.data === "verify_join") {
      await sendMessage(
        chatId,
        "✅ যাচাই সম্পন্ন! ভাষা বেছে নিন।\nChoose your language.",
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
          : "🇬🇧 English selected. Now send a search topic.",
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
        "🇧🇩 বাংলা অথবা 🇬🇧 English বেছে নিন। এরপর যেকোনো বিষয় লিখুন।\n\n" +
        "Choose your language from the menu, then send a name or topic.",
      { parse_mode: "HTML", reply_markup: mainKeyboard() }
    );
    return;
  }

  if (cmd === "help" || text === "ℹ️ Help") {
    await sendMessage(
      chatId,
      "📖 <b>Help / সাহায্য</b>\n\n" +
        "• ভাষা নির্বাচন করুন।\n" +
        "• সার্চের নাম বা বিষয় লিখুন।\n" +
        "• Wikipedia আর্টিকেলের সঙ্গে যুক্ত ছবিগুলো পাওয়া গেলে পাঠানো হবে।\n" +
        "• Full Article বাটনে মূল আর্টিকেল খুলুন।",
      { parse_mode: "HTML", reply_markup: mainKeyboard() }
    );
    return;
  }

  if (cmd === "about" || text === "🤖 About") {
    await sendMessage(
      chatId,
      "🤖 Wiki Search Bot\nবাংলা ও English Wikipedia search.\n\n" +
        "Required channels:\nhttps://t.me/KBCYBERTEAM\nhttps://t.me/iptvlinksm3u8",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (text === "🇧🇩 বাংলা") {
    languageByUser.set(userId, "bn");
    await sendMessage(
      chatId,
      "✅ বাংলা ভাষা নির্বাচন করা হয়েছে। এখন সার্চের বিষয় লিখুন।",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (text === "🇬🇧 English") {
    languageByUser.set(userId, "en");
    await sendMessage(
      chatId,
      "✅ English selected. Send a name or topic to search.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const lang = languageByUser.get(userId);

  if (!lang) {
    await sendMessage(
      chatId,
      "🌐 প্রথমে নিচের Menu থেকে ভাষা বেছে নিন।\nChoose your language first.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  await showSearch(chatId, text, lang);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Wiki Search Bot is running.");
  }

  if (!BOT_TOKEN || !WEBHOOK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Missing environment variables."
    });
  }

  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    await handleUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Update failed:", error.message);
    return res.status(200).json({ ok: true });
  }
}
