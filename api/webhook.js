// api/webhook.js

import { createClient } from '@supabase/supabase-js';

// Временно используем только конфигурацию, чтобы не вызывать ошибку
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Инициализация (пока что без логики)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;


// Основной обработчик (Webhook)
export default async (request, response) => {
    try {
        // Проверка метода POST (обязательна)
        if (request.method !== 'POST') {
            return response.status(405).send('Only POST requests allowed');
        }

        const message = request.body.message;

        if (message && message.text && message.text.startsWith('/start')) {
             // Минимальный ответ для проверки работоспособности
             const chatId = message.chat.id;
             await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: 'Система инициализирована. Начинаем кодирование!',
                }),
            });
        }
        
        // Обязательный ответ 200 OK для Telegram
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook failed:', e);
        response.status(500).send('Server Error');
    }
};
