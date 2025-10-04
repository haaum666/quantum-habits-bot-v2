// api/webhook.js

// Инициализация Supabase убрана, чтобы исключить ошибки
// import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ TELEGRAM
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 2. ФУНКЦИЯ ДЛЯ ОТВЕТА В TELEGRAM
async function sendTelegramMessage(chatId, text) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
        }),
    });
    return response.json();
}

// 3. ОСНОВНОЙ ОБРАБОТЧИК (Webhook)
export default async (request, response) => {
    try {
        if (request.method !== 'POST') {
            return response.status(405).send('Only POST requests allowed');
        }

        const body = request.body;
        const message = body.message;

        if (!message || !message.text || !message.chat) {
            return response.status(200).send('No message to process');
        }

        const chatId = message.chat.id;
        const incomingText = message.text.trim();

        // Отправка сообщения без обращения к базе данных
        const welcomeMessage = `👋 Бот запущен! Токен Telegram работает. Входящий текст: ${incomingText}`;
        await sendTelegramMessage(chatId, welcomeMessage);
        
        // Обязательный ответ 200 OK для Telegram
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook processing failed:', e);
        // Добавление отправки ошибки в Telegram для диагностики
        await sendTelegramMessage(chatId, `КРИТИЧЕСКАЯ ОШИБКА: ${e.message}`); 
        response.status(500).send('Server Error');
    }
};
