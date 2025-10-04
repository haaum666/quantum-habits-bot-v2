// api/webhook.js

import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ SUPABASE И TELEGRAM
// Теперь читаем ключи с префиксом BOT_
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.BOT_SUPABASE_ANON_KEY; 
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Токен Telegram оставляем без префикса, так как он уникален

// Инициализация клиента Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Базовый URL для отправки ответов в Telegram API
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
    let chatId; 
    try {
        if (request.method !== 'POST') {
            return response.status(405).send('Only POST requests allowed');
        }

        const body = request.body;
        const message = body.message;

        if (!message || !message.text || !message.chat) {
            return response.status(200).send('No message to process');
        }

        chatId = message.chat.id;
        const incomingText = message.text.trim();

        // Проверка существования пользователя в базе
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('telegram_id, onboarding_state')
            .eq('telegram_id', chatId)
            .single();

        // Обработка ошибки базы данных, если она не 'No rows returned'
        if (userError && userError.code !== 'PGRST116') {
            console.error('Supabase Error:', userError);
            await sendTelegramMessage(chatId, `Ошибка базы данных: ${userError.message}`); 
            return response.status(500).send('Database Error');
        }
        
        // ... (Остальная логика онбординга остается прежней) ...
        // (Логика онбординга удалена здесь для краткости, она полная в вашем файле)

        const isStartCommand = incomingText.startsWith('/start');
        
        if (isStartCommand || !userData) {
            
            // 1. Вставка нового пользователя
            if (!userData) {
                const { error: insertError } = await supabase
                    .from('users')
                    .insert([{ telegram_id: chatId, onboarding_state: 'STEP_1' }]);
                
                if (insertError) {
                    console.error('Insert Error:', insertError);
                    await sendTelegramMessage(chatId, `Ошибка при вставке: ${insertError.message}`);
                    return response.status(500).send('Database Insert Error');
                }
            }

            // 2. Отправка первого вопроса
            const welcomeMessage = `👋 *Привет!* Я твой личный бот-помощник по методу \"Атомных Привычек\".\n\nЯ помогу тебе строить системы, которые приведут к 1% улучшению каждый день. \n\nДавай начнем с главного.`;
            await sendTelegramMessage(chatId, welcomeMessage);
            
            await sendTelegramMessage(chatId, "*ШАГ 1 из 10: КЕМ ты хочешь стать?*\n\nВся сила в Идентичности. Напиши, кем ты хочешь стать благодаря своим привычкам (например: \"Здоровым и энергичным\", \"Продуктивным и организованным\", \"Образованным и развитым\").");

        } else {

            // Обработка ответа на ШАГ 1: Идентичность
            if (userData.onboarding_state === 'STEP_1') {
                const identityText = incomingText.substring(0, 100); 

                // Обновляем запись пользователя
                const { error: updateError } = await supabase
                    .from('users')
                    .update({
                        desired_identity: identityText,
                        onboarding_state: 'STEP_2'
                    })
                    .eq('telegram_id', chatId);

                if (updateError) {
                    console.error('Update Identity Error:', updateError);
                    await sendTelegramMessage(chatId, `Ошибка при обновлении: ${updateError.message}`);
                    return response.status(500).send('Database Update Error');
                }

                // Отправляем подтверждение и следующий вопрос
                const confirmationMessage = `Отлично! Вы выбрали Идентичность: *${identityText}*.\n\nКаждый раз, когда вы выполняете привычку, вы голосуете за эту личность.`;
                await sendTelegramMessage(chatId, confirmationMessage);

                // Следующий вопрос: Выбор первой привычки (ШАГ 2 из 10)
                await sendTelegramMessage(chatId, "*ШАГ 2 из 10: Что ты будешь делать?*\n\nВспомните Правило Двух Минут: Любая привычка должна занимать не более 2 минут.\n\nНапиши, какую микро-привычку ты готов выполнять ежедневно (например: \"Отжаться 1 раз\", \"Прочитать 1 страницу\", \"Выпить 1 стакан воды\").");

            
            // Заглушка для всех других состояний
            } else {
                await sendTelegramMessage(chatId, `С возвращением! Твой текущий статус онбординга: *${userData.onboarding_state}*.\n\n_Пока что я могу обрабатывать только ответы на STEP_1._`);
            }
        }
        
        // Обязательный ответ 200 OK для Telegram
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook processing failed:', e);
        if (chatId) {
            await sendTelegramMessage(chatId, `КРИТИЧЕСКАЯ ОШИБКА: ${e.message}.`); 
        }
        response.status(500).send('Server Error');
    }
};
