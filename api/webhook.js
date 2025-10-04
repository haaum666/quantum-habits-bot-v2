// api/webhook.js

import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ SUPABASE И TELEGRAM
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Инициализация клиента Supabase с Service Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); 

// Базовый URL для отправки ответов в Telegram API
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 2. ФУНКЦИЯ ДЛЯ ОТВЕТА В TELEGRAM
async function sendTelegramMessage(chatId, text, parse_mode = 'Markdown') {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: parse_mode, // Используем Markdown по умолчанию
        }),
    });
    if (!response.ok) {
        // Логируем ошибку, но не выбрасываем ее, чтобы избежать Body has already been read
        console.error(`Telegram API Error: ${await response.text()}`);
    }
    return response.json();
}

// 3. ОСНОВНОЙ ОБРАБОТЧИК (Webhook)
export default async (request, response) => {
    
    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests allowed');
    }

    let body;
    try {
        // Гарантированное чтение тела запроса
        const rawBody = await new Promise((resolve) => {
            let data = '';
            request.on('data', chunk => data += chunk);
            request.on('end', () => resolve(data));
        });
        body = JSON.parse(rawBody);

    } catch (e) {
        console.error('Body parsing failed:', e);
        return response.status(400).send('Invalid request body');
    }

    const message = body.message;

    if (!message || !message.text || !message.chat) {
        return response.status(200).send('No message to process');
    }

    const chatId = message.chat.id;
    const incomingText = message.text.trim();

    try {
        // A. Проверка существования пользователя в базе
        const { data: userData, error: userError } = await supabase
            .from('users') 
            .select('telegram_id, onboarding_state')
            .eq('telegram_id', chatId)
            .single();

        // Обработка ошибки БД, если она не 'No rows returned' (PGRST116)
        if (userError && userError.code !== 'PGRST116') {
            console.error('Supabase Error (SELECT):', userError);
            // Отправляем чистую ошибку без Markdown, чтобы не падать
            await sendTelegramMessage(chatId, `Критическая ошибка БД. Код: ${userError.code}.`, 'HTML');
            return response.status(500).send('Database Error');
        }
        
        // ===============================================
        // ЛОГИКА 1: КОМАНДА /start (Или Новый Пользователь)
        // ===============================================
        const isStartCommand = incomingText.startsWith('/start');
        
        if (isStartCommand || !userData) {
            
            // 1. Вставка нового пользователя (только если не существует)
            if (!userData) {
                const { error: insertError } = await supabase
                    .from('users')
                    .insert([{ telegram_id: chatId, onboarding_state: 'STEP_1' }]);
                
                if (insertError) {
                    // Обрабатываем ошибку дубликата ключа (23505) как ожидаемое событие
                    if (insertError.code === '23505') {
                        // Пользователь уже существует, продолжаем работу.
                        console.log('Пользователь уже существует, продолжаем работу.');
                    } else {
                        console.error('Insert Error:', insertError);
                         // Отправляем чистую ошибку без Markdown
                        await sendTelegramMessage(chatId, `Ошибка БД (INSERT). Код: ${insertError.code}.`, 'HTML');
                        return response.status(500).send('Database Insert Error');
                    }
                }
            }
            
            // 2. Отправка первого вопроса
            const welcomeMessage = `👋 *Привет!* Я твой личный бот-помощник по методу \"Атомных Привычек\".\n\nЯ помогу тебе строить системы, которые приведут к 1% улучшению каждый день. \n\nДавай начнем с главного.`;
            await sendTelegramMessage(chatId, welcomeMessage);
            
            await sendTelegramMessage(chatId, "*ШАГ 1 из 10: КЕМ ты хочешь стать?*\n\nВся сила в Идентичности. Напиши, кем ты хочешь стать благодаря своим привычкам (например: \"Здоровым и энергичным\", \"Продуктивным и организованным\", \"Образованным и развитым\").");

        // ===============================================
        // ЛОГИКА 2: ОБРАБОТКА ТЕКСТА (Ответ на вопрос)
        // ===============================================
        } else {
            // ... (логика обработки ответа)
            if (userData.onboarding_state === 'STEP_1') {
                const identityText = incomingText.substring(0, 100);

                const { error: updateError } = await supabase
                    .from('users')
                    .update({
                        desired_identity: identityText,
                        onboarding_state: 'STEP_2'
                    })
                    .eq('telegram_id', chatId);

                if (updateError) {
                    console.error('Update Identity Error:', updateError);
                     // Отправляем чистую ошибку без Markdown
                    await sendTelegramMessage(chatId, `Ошибка БД (UPDATE). Код: ${updateError.code}.`, 'HTML');
                    return response.status(500).send('Database Update Error');
                }

                const confirmationMessage = `Отлично! Вы выбрали Идентичность: *${identityText}*.\n\nКаждый раз, когда вы выполняете привычку, вы голосуете за эту личность.`;
                await sendTelegramMessage(chatId, confirmationMessage);

                await sendTelegramMessage(chatId, "*ШАГ 2 из 10: Что ты будешь делать?*\n\nВспомните Правило Двух Минут: Любая привычка должна занимать не более 2 минут.\n\nНапиши, какую микро-привычку ты готов выполнять ежедневно (например: \"Отжаться 1 раз\", \"Прочитать 1 страницу\", \"Выпить 1 стакан воды\").");
            
            } else {
                await sendTelegramMessage(chatId, `С возвращением! Твой текущий статус онбординга: *${userData.onboarding_state}*.\n\n_Пока что я могу обрабатывать только ответы на STEP_1._`);
            }
        }
        
        // Обязательный ответ 200 OK для Telegram
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook processing failed (uncaught):', e);
        // Не пытаемся отправить сообщение в ТГ, чтобы избежать повторной ошибки "Body already read"
        response.status(500).send('Server Error');
    }
};
