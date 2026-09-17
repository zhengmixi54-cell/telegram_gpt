import express from "express";

import {

  McpServer

} from "@modelcontextprotocol/sdk/server/mcp.js";

import {

  StreamableHTTPServerTransport

} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { z } from "zod";

import { spawn } from "child_process";

import {

  writeFile,

  unlink,

  readFile

} from "fs/promises";

import { randomUUID } from "crypto";

import os from "os";

import path from "path";

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const AUTH_TOKEN = process.env.MCP_API_TOKEN;

const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;

const ELEVENLABS_API_KEY =

  process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =

  process.env.ELEVENLABS_VOICE_ID ||

  "21m00Tcm4TlvDq8ikWAM";

if (!BOT_TOKEN) {

  console.warn("[warn] TELEGRAM_BOT_TOKEN is not set.");

}

if (!ELEVENLABS_API_KEY) {

  console.warn("[warn] ELEVENLABS_API_KEY is not set.");

}

/* =========================

   Telegram Text

========================= */

async function sendTelegramMessage(text, chatId) {

  const targetChatId =

    chatId || DEFAULT_CHAT_ID;

  if (!targetChatId) {

    throw new Error(

      "No chat id provided and TELEGRAM_CHAT_ID is not set."

    );

  }

  const url =

    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {

    method: "POST",

    headers: {

      "Content-Type": "application/json"

    },

    body: JSON.stringify({

      chat_id: targetChatId,

      text

    })

  });

  const data = await res.json();

  if (!data.ok) {

    throw new Error(

      `Telegram API error: ${JSON.stringify(data)}`

    );

  }

  return data;

}

/* =========================

   ElevenLabs TTS

========================= */

async function textToSpeechMp3(text) {

  if (!ELEVENLABS_API_KEY) {

    throw new Error(

      "ELEVENLABS_API_KEY is not configured."

    );

  }

  const url =

    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const res = await fetch(url, {

    method: "POST",

    headers: {

      "xi-api-key": ELEVENLABS_API_KEY,

      "Content-Type": "application/json",

      "Accept": "audio/mpeg"

    },

    body: JSON.stringify({

      text,

      model_id: "eleven_multilingual_v2",

      voice_settings: {

        stability: 0.5,

        similarity_boost: 0.75

      }

    })

  });

  if (!res.ok) {

    const errText = await res.text();

    throw new Error(

      `ElevenLabs API error (${res.status}): ${errText}`

    );

  }

  const arrayBuffer =

    await res.arrayBuffer();

  return Buffer.from(arrayBuffer);

}

/* =========================

   MP3 → OGG/Opus

========================= */

function mp3ToOggOpus(mp3Buffer) {

  return new Promise(async (resolve, reject) => {

    const tmpIn =

      path.join(

        os.tmpdir(),

        `${randomUUID()}.mp3`

      );

    const tmpOut =

      path.join(

        os.tmpdir(),

        `${randomUUID()}.ogg`

      );

    try {

      await writeFile(

        tmpIn,

        mp3Buffer

      );

      const ff =

        spawn("ffmpeg", [

          "-y",

          "-i",

          tmpIn,

          "-c:a",

          "libopus",

          "-b:a",

          "64k",

          "-vbr",

          "on",

          tmpOut

        ]);

      let stderr = "";

      ff.stderr.on(

        "data",

        (d) => {

          stderr += d.toString();

        }

      );

      ff.on(

        "close",

        async (code) => {

          try {

            if (code !== 0) {

              reject(

                new Error(

                  `ffmpeg exited with code ${code}: ${stderr}`

                )

              );

              return;

            }

            const oggBuffer =

              await readFile(tmpOut);

            resolve(oggBuffer);

          } finally {

            unlink(tmpIn).catch(() => {});

            unlink(tmpOut).catch(() => {});

          }

        }

      );

    } catch (err) {

      reject(err);

    }

  });

}

/* =========================

   Telegram Voice

========================= */

async function sendTelegramVoice(

  oggBuffer,

  chatId

) {

  const targetChatId =

    chatId || DEFAULT_CHAT_ID;

  if (!targetChatId) {

    throw new Error(

      "No chat id provided and TELEGRAM_CHAT_ID is not set."

    );

  }

  const url =

    `https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`;

  const form = new FormData();

  form.append(

    "chat_id",

    targetChatId

  );

  form.append(

    "voice",

    new Blob(

      [oggBuffer],

      {

        type: "audio/ogg"

      }

    ),

    "voice.ogg"

  );

  const res =

    await fetch(url, {

      method: "POST",

      body: form

    });

  const data =

    await res.json();

  if (!data.ok) {

    throw new Error(

      `Telegram API error: ${JSON.stringify(data)}`

    );

  }

  return data;

}

/* =========================

   MCP

========================= */

function buildServer() {

  const server =

    new McpServer({

      name: "telegram-notify",

      version: "1.2.0"

    });

  /* ---------- Text ---------- */

  server.registerTool(

    "send_telegram_message",

    {

      title: "Send Telegram Message",

      description:

        "Send a text message to the configured Telegram chat.",

      inputSchema: {

        text: z

          .string()

          .describe(

            "The exact message to send."

          ),

        chat_id: z

          .string()

          .optional()

          .describe(

            "Optional Telegram chat ID."

          )

      }

    },

    async ({

      text,

      chat_id

    }) => {

      try {

        await sendTelegramMessage(

          text,

          chat_id

        );

        return {

          content: [

            {

              type: "text",

              text:

                `Message sent to Telegram: "${text}"`

            }

          ]

        };

      } catch (err) {

        return {

          content: [

            {

              type: "text",

              text:

                `Failed to send message: ${err.message}`

            }

          ],

          isError: true

        };

      }

    }

  );

  /* ---------- Voice ---------- */

  server.registerTool(

    "send_telegram_voice",

    {

      title:

        "Send Telegram Voice Message",

      description:

        "Convert text to speech and send it as a Telegram voice message.",

      inputSchema: {

        text: z

          .string()

          .describe(

            "The text to convert to speech."

          ),

        chat_id: z

          .string()

          .optional()

          .describe(

            "Optional Telegram chat ID."

          )

      }

    },

    async ({

      text,

      chat_id

    }) => {

      try {

        const mp3 =

          await textToSpeechMp3(

            text

          );

        const ogg =

          await mp3ToOggOpus(

            mp3

          );

        await sendTelegramVoice(

          ogg,

          chat_id

        );

        return {

          content: [

            {

              type: "text",

              text:

                `Voice message sent to Telegram: "${text}"`

            }

          ]

        };

      } catch (err) {

        return {

          content: [

            {

              type: "text",

              text:

                `Failed to send voice message: ${err.message}`

            }

          ],

          isError: true

        };

      }

    }

  );

  return server;

}

/* =========================

   Express

========================= */

const app =

  express();

app.use(

  express.json({

    limit: "2mb"

  })

);

/* =========================

   Health

========================= */

app.get(

  "/health",

  (_req, res) => {

    res.json({

      status: "ok",

      service: "telegram-gpt",

      mcp: "/mcp"

    });

  }

);

/* =========================

   MCP Authentication

========================= */

app.use(

  (req, res, next) => {

    if (!AUTH_TOKEN) {

      return next();

    }

    const header =

      req.headers.authorization || "";

    const token =

      header.startsWith("Bearer ")

        ? header.slice(7)

        : null;

    if (token !== AUTH_TOKEN) {

      return res

        .status(401)

        .json({

          error: "Unauthorized"

        });

    }

    next();

  }

);

/* =========================

   NEW:

   Telegram HTTP API

========================= */

app.post(

  "/telegram/send",

  async (req, res) => {

    try {

      /* API key protection */

      if (TELEGRAM_API_KEY) {

        const header =

          req.headers.authorization || "";

        const token =

          header.startsWith("Bearer ")

            ? header.slice(7)

            : null;

        if (

          token !== TELEGRAM_API_KEY

        ) {

          return res

            .status(401)

            .json({

              ok: false,

              error: "Unauthorized"

            });

        }

      }

      const {

        text,

        chat_id

      } = req.body;

      if (

        !text ||

        typeof text !== "string"

      ) {

        return res

          .status(400)

          .json({

            ok: false,

            error:

              "text is required"

          });

      }

      const result =

        await sendTelegramMessage(

          text,

          chat_id

        );

      return res.json({

        ok: true,

        message_id:

          result.result?.message_id,

        chat_id:

          chat_id ||

          DEFAULT_CHAT_ID

      });

    } catch (error) {

      console.error(

        "[telegram/send]",

        error

      );

      return res

        .status(500)

        .json({

          ok: false,

          error:

            error.message

        });

    }

  }

);

/* =========================

   MCP Endpoint

========================= */

app.post(

  "/mcp",

  async (req, res) => {

    try {

      const server =

        buildServer();

      const transport =

        new StreamableHTTPServerTransport({

          sessionIdGenerator:

            undefined

        });

      res.on(

        "close",

        () => {

          transport.close();

          server.close();

        }

      );

      await server.connect(

        transport

      );

      await transport.handleRequest(

        req,

        res,

        req.body

      );

    } catch (error) {

      console.error(

        "[MCP]",

        error

      );

      if (!res.headersSent) {

        res

          .status(500)

          .json({

            error:

              error.message

          });

      }

    }

  }

);

/* =========================

   Start

========================= */

app.listen(

  PORT,

  "0.0.0.0",

  () => {

    console.log(

      `Telegram server listening on port ${PORT}`

    );

  }

);
