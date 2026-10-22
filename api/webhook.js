
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;

const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function telegram(method, body) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!result.ok) {
    console.error("Telegram API error:", result.description);
  }

  return result;
}

function keyboard() {
  return {
    keyboard: [
      [{ text: "🔎 Search Celebrity" }],
      [
        { text: "ℹ️ Help" },
        { text: "🌐 About" }
      ]
    ],
    resize_keyboard: true
  };
}

async function sendText(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function searchCelebrity(name) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: name,
    srlimit: "1",
    format: "json",
    utf8: "1"
  });

  let response = await fetch(
    `https://en.wikipedia.org/w/api.php?${params}`,
    {
      headers: {
        "User-Agent": "CelebrityInfoBot/1.0 (Telegram bot)"
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) throw new Error("Wikipedia unavailable");

  let data = await response.json();
  let result = data.query?.search?.[0];

  // Fallback to Bengali Wikipedia if English search has no result
  if (!result) {
    const bnParams = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: name,
      srlimit: "1",
      format: "json",
      utf8: "1"
    });

    response = await fetch(
      `https://bn.wikipedia.org/w/api.php?${bnParams}`,
      {
        headers: {
          "User-Agent": "CelebrityInfoBot/1.0"
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) throw new Error("Wikipedia unavailable");

    data = await response.json();
    result = data.query?.search?.[0];

    if (!result) return null;

    return getPageInfo(result.title, "bn");
  }

  return getPageInfo(result.title, "en");
}

async function getPageInfo(title, lang) {
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts|pageimages|info",
    titles: title,
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail",
    pithumbsize: "600",
    inprop: "url",
    format: "json",
    redirects: "1"
  });

  const response = await fetch(
    `https://${lang}.wikipedia.org/w/api.php?${params}`,
    {
      headers: {
        "User-Agent": "CelebrityInfoBot/1.0"
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) throw new Error("Wikipedia unavailable");

  const data = await response.json();
  const page = Object.values(data.query?.pages || {})[0];

  if (!page || page.missing !== undefined) return null;

  return {
    title: page.title,
    description: page.extract || "No biography summary available.",
    image: page.thumbnail?.source || null,
    url: page.fullurl ||
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`
  };
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const cb = update.callback_query;

    await telegram("answerCallbackQuery", {
      callback_query_id: cb.id
    });

    if (cb.data === "search_again") {
      await sendText(
        cb.message.chat.id,
        "🔎 Send the actor or actress name you want to search.",
        { reply_markup: keyboard() }
      );
    }
    return;
  }

  const message = update.message;
  if (!message?.chat || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendText(
      chatId,
      "🎬 Welcome to Celebrity Info Bot!\n\n" +
      "Search actors and actresses to find their Wikipedia biography, available photo and article link.\n\n" +
      "👇 Tap Search Celebrity or send a name.",
      {
        reply_markup: keyboard(),
        reply_to_message_id: message.message_id
      }
    );
    return;
  }

  if (text === "/help" || text === "ℹ️ Help") {
    await sendText(
      chatId,
      "ℹ️ HOW TO USE\n\n" +
      "• Send a celebrity's name.\n" +
      "• Get an available photo and biography.\n" +
      "• Open the Wikipedia article for more details.\n\n" +
      "Examples:\n" +
      "Leonardo DiCaprio\n" +
      "Angelina Jolie\n" +
      "শাকিব খান\n\n" +
      "Commands: /start /help /about",
      { reply_markup: keyboard() }
    );
    return;
  }

  if (text === "/about" || text === "🌐 About") {
    await sendText(
      chatId,
      "🎬 Celebrity Info Bot\n\n" +
      "Powered by Wikipedia.\n" +
      "Photos and biography availability depend on the source article.\n" +
      "This bot is not affiliated with Wikipedia.",
      { reply_markup: keyboard() }
    );
    return;
  }

  if (text === "🔎 Search Celebrity") {
    await sendText(
      chatId,
      "🔎 Enter an actor or actress name to search.",
      { reply_markup: keyboard() }
    );
    return;
  }

  const query = text.replace(/^\/search(?:@\w+)?\s*/i, "").trim();

  if (query.startsWith("/") || !query || query.length > 200) {
    await sendText(
      chatId,
      "Please send a valid name (maximum 200 characters).",
      { reply_markup: keyboard() }
    );
    return;
  }

  const waiting = await sendText(chatId, "🔍 Searching Wikipedia...");

  try {
    const person = await searchCelebrity(query);

    if (!person) {
      await sendText(
        chatId,
        "❌ No matching Wikipedia article found.\nTry another spelling or name.",
        { reply_markup: keyboard() }
      );
      return;
    }

    const description = person.description.slice(0, 3000);

    const caption =
      `🎬 ${person.title}\n\n` +
      `${description}\n\n` +
      `📚 Source: Wikipedia`;

    const buttons = {
      inline_keyboard: [
        [{ text: "📖 Read Full Biography", url: person.url }],
        [{ text: "🔎 Search Another", callback_data: "search_again" }]
      ]
    };

    if (person.image) {
      const photoResult = await telegram("sendPhoto", {
        chat_id: chatId,
        photo: person.image,
        caption: caption.slice(0, 1000),
        reply_markup: buttons
      });

      if (!photoResult.ok) {
        await sendText(chatId, caption, {
          reply_markup: buttons,
          link_preview_options: { is_disabled: true }
        });
      }
    } else {
      await sendText(chatId, caption, {
        reply_markup: buttons,
        link_preview_options: { is_disabled: true }
      });
    }
  } catch (error) {
    console.error("Celebrity search failed:", error.message);

    await sendText(
      chatId,
      "⚠️ Search is temporarily unavailable. Please try again later.",
      { reply_markup: keyboard() }
    );
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  if (!TELEGRAM_TOKEN || !SECRET) {
    return res.status(500).json({
      success: false,
      error: "Bot configuration missing"
    });
  }

  if (
    req.headers["x-telegram-bot-api-secret-token"] !== SECRET
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  try {
    await handleUpdate(req.body || {});
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(200).json({ ok: true });
  }
};
