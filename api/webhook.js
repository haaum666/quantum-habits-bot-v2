// api/webhook.js

import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ SUPABASE И TELEGRAM
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
// Используем Service Role Key для обхода RLS и максимальной надежности
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
            parse_mode: parse_mode, 
        }),
    });
    if (!response.ok) {
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

        if (userError && userError.code !== 'PGRST116') {
            console.error('Supabase Error (SELECT):', userError);
            await sendTelegramMessage(chatId, `Критическая ошибка БД. Код: ${userError.code}.`, 'HTML');
            return response.status(500).send('Database Error');
        }
        
        // ===============================================
        // ЛОГИКА 1: КОМАНДА /start (Или Новый Пользователь)
        // ===============================================
        const isStartCommand = incomingText.startsWith('/start');
        
        if (isStartCommand || !userData) {
            
            if (!userData) {
                const { error: insertError } = await supabase
                    .from('users')
                    .insert([{ telegram_id: chatId, onboarding_state: 'STEP_1' }]);
                
                if (insertError) {
                    if (insertError.code === '23505') {
                        console.log('Пользователь уже существует, продолжаем работу.');
                    } else {
                        console.error('Insert Error:', insertError);
                        await sendTelegramMessage(chatId, `Ошибка БД (INSERT). Код: ${insertError.code}.`, 'HTML');
                        return response.status(500).send('Database Insert Error');
                    }
                }
            }
            
            // Отправка первого вопроса
            const welcomeMessage = `👋 *Привет!* Я твой личный бот-помощник по методу \"Атомных Привычек\".\n\nЯ помогу тебе строить системы, которые приведут к 1% улучшению каждый день. \n\nДавай начнем с главного.`;
            await sendTelegramMessage(chatId, welcomeMessage);
            
            await sendTelegramMessage(chatId, "*ШАГ 1 из 10: КЕМ ты хочешь стать?*\n\nВся сила в Идентичности. Напиши, кем ты хочешь стать благодаря своим привычкам (например: \"Здоровым и энергичным\", \"Продуктивным и организованным\", \"Образованным и развитым\").");

        // ===============================================
        // ЛОГИКА 2: ОБРАБОТКА ТЕКСТА (Онбординг)
        // ===============================================
        } else {
            const currentStep = userData.onboarding_state;
            const textToSave = incomingText.substring(0, 100);
            let updatePayload = {};
            let nextState = '';
            let confirmationMessage = '';
            let nextQuestion = '';

            switch (currentStep) {
                case 'STEP_1':
                    updatePayload = { desired_identity: textToSave, onboarding_state: 'STEP_2' };
                    confirmationMessage = `Отлично! Вы выбрали Идентичность: *${textToSave}*.\n\nКаждый раз, когда вы выполняете привычку, вы голосуете за эту личность.`;
                    nextQuestion = "*ШАГ 2 из 10: Что ты будешь делать?*\n\nВспомните Правило Двух Минут: Любая привычка должна занимать не более 2 минут.\n\nНапиши, какую микро-привычку ты готов выполнять ежедневно (например: \"Отжаться 1 раз\", \"Прочитать 1 страницу\", \"Выпить 1 стакан воды\").";
                    break;
                case 'STEP_2':
                    updatePayload = { habit_micro_step: textToSave, onboarding_state: 'STEP_3' };
                    confirmationMessage = `Хорошо. Ваша микро-привычка: *${textToSave}*.\n\nПомните: начинать нужно с легкого, чтобы не пропустить.\n\n*Правило 3: Сделайте ее Легкой.*`;
                    nextQuestion = "*ШАГ 3 из 10: Где ты это сделаешь?*\n\nМы привязываем новую привычку к существующему действию. Это \"Связывание привычек\".\n\nНапиши, после какого ежедневного действия ты выполнишь эту привычку (например: \"После того, как заварю утренний кофе\", \"После того, как почищу зубы\", \"После того, как сяду за рабочий стол\").";
                    break;
                case 'STEP_3':
                    updatePayload = { habit_link_action: textToSave, onboarding_state: 'STEP_4' };
                    confirmationMessage = `Запомнено. Вы будете выполнять привычку *ПОСЛЕ* того, как: *${textToSave}*.\n\n*Правило 4: Сделайте ее Удовлетворительной.*`;
                    nextQuestion = "*ШАГ 4 из 10: Чем ты себя наградишь?*\n\nДля завершения цикла привычки (Подсказка -> Действие -> Награда) нужно вознаграждение.\n\nНапиши, чем ты себя немедленно наградишь после выполнения микро-привычки (например: \"Выпью чашку чая с лимоном\", \"Сделаю 5 минут растяжки\", \"Просмотрю 1 минуту новостной ленты\").";
                    break;
                case 'STEP_4':
                    updatePayload = { habit_reward: textToSave, onboarding_state: 'STEP_5' };
                    confirmationMessage = `Идеально. Награда: *${textToSave}*.\n\nЭто создает петлю обратной связи: мозг получает дофамин и запоминает, что это действие нужно повторять.`;
                    nextQuestion = "*ШАГ 5 из 10: Каким трекером пользоваться?*\n\nОтслеживание помогает увидеть прогресс.\n\nНапиши, какой трекер ты будешь использовать для отметки выполнения (например: \"Приложение Loop\", \"Лист бумаги и ручка\", \"Отметка в заметках телефона\").";
                    break;
                case 'STEP_5':
                    updatePayload = { habit_tracker: textToSave, onboarding_state: 'STEP_6' };
                    confirmationMessage = `Отлично! Вы выбрали трекер: *${textToSave}*.\n\nЦель трекера - не только показать прогресс, но и создать визуальный сигнал, что привычка не была пропущена.`;
                    nextQuestion = "*ШАГ 6 из 10: Как назвать привычку для статистики?*\n\nДля удобства в статистике нужна короткая, легко узнаваемая фраза.\n\nНапиши короткий идентификатор для привычки (например: \"1отжим\", \"1стркнига\", \"Вода1стак\").";
                    break;
                case 'STEP_6':
                    updatePayload = { habit_identifier: textToSave, onboarding_state: 'STEP_7' };
                    confirmationMessage = `Идентификатор: *${textToSave}*.\n\nТеперь, когда ты увидишь этот ID, ты точно будешь знать, что нужно отметить.`;
                    nextQuestion = "*ШАГ 7 из 10: Какое первое препятствие?*\n\nПланирование провала - ключ к успеху. Что вероятнее всего помешает тебе сегодня/завтра?\n\nНапиши одно самое вероятное препятствие (например: \"Усталость после работы\", \"Забуду о привычке\", \"Не хватит времени\").";
                    break;
                case 'STEP_7':
                    updatePayload = { obstacle_plan_1: textToSave, onboarding_state: 'STEP_8' };
                    confirmationMessage = `Препятствие определено: *${textToSave}*.\n\nМы готовы к борьбе.`;
                    nextQuestion = `*ШАГ 8 из 10: План преодоления?*\n\nЕсли возникнет *${textToSave}*, то что ты сделаешь?\n\nНапиши план (например: "Если устану, сделаю отжимание сразу после того, как приду домой", "Если забуду, поставлю будильник на 17:00").`;
                    break;
                case 'STEP_8':
                    updatePayload = { obstacle_plan_2: textToSave, onboarding_state: 'STEP_9' };
                    confirmationMessage = `План преодоления: *${textToSave}*.\n\nТы подготовил себя к успеху. Больше не нужно полагаться на мотивацию.`;
                    nextQuestion = "*ШАГ 9 из 10: Что делать при пропуске?*\n\nНикогда не пропускай привычку *дважды подряд*. Это единственное правило.\n\nНапиши, как ты гарантированно вернешься к привычке после одного пропуска (например: \"Начну со второй половины дня\", \"Сделаю ее сразу же, как вспомню, независимо от времени\").";
                    break;
                case 'STEP_9':
                    updatePayload = { failure_plan: textToSave, onboarding_state: 'STEP_10' };
                    confirmationMessage = `Правило при пропуске: *${textToSave}*.\n\nЭто защищает тебя от срыва. Один пропуск - случайность. Два - начало новой, плохой привычки.`;
                    nextQuestion = "*ШАГ 10 из 10: Время повторения?*\n\nЧтобы я мог отправлять напоминания и собирать статистику, нужно время.\n\nНапиши время, когда ты планируешь выполнять привычку (например: \"18:30\", \"8:00\", \"Сразу после обеда\").";
                    break;
                case 'STEP_10':
                    // Финальный шаг!
                    updatePayload = { repetition_schedule: textToSave, onboarding_state: 'COMPLETED' };
                    nextState = 'COMPLETED'; // Устанавливаем статус завершения
                    confirmationMessage = `🎉 *ОБОРДИНГ ЗАВЕРШЕН!* 🎉\n\nТы готов! Я буду отправлять тебе напоминания в *${textToSave}*.\n\nТвоя полная формула:\n*Идентичность:* ${userData.desired_identity || 'Не указана'}\n*Привычка:* ${userData.habit_micro_step || 'Не указана'}\n*Связка:* ${userData.habit_link_action || 'Не указана'}\n\n*Начни сейчас:* Твоя первая привычка: ${userData.habit_micro_step || 'Не указана'} СРАЗУ ПОСЛЕ ${userData.habit_link_action || 'Не указано'}.`;
                    nextQuestion = null; // Нет следующего вопроса
                    break;
                case 'COMPLETED':
                    confirmationMessage = `Ты уже завершил онбординг! Твоя привычка: ${userData.habit_micro_step || 'Не указана'}. \n\n_Напиши /start, чтобы начать заново, или просто жди напоминания!_`;
                    nextQuestion = null;
                    break;
                default:
                    // Если состояние не распознано
                    confirmationMessage = `Ошибка! Неизвестный статус онбординга: *${currentStep}*.\n\nНапиши /start, чтобы начать заново.`;
                    nextQuestion = null;
            }
            
            // Если мы не в состоянии 'COMPLETED', пытаемся обновить БД
            if (currentStep !== 'COMPLETED' && currentStep !== 'ERROR' && currentStep !== 'DEFAULT') {

                const { error: updateError } = await supabase
                    .from('users')
                    .update(updatePayload)
                    .eq('telegram_id', chatId);

                if (updateError) {
                    console.error(`Update Error (${currentStep}):`, updateError);
                    await sendTelegramMessage(chatId, `Ошибка БД (UPDATE). Код: ${updateError.code}.`, 'HTML');
                    return response.status(500).send('Database Update Error');
                }
            }
            
            // Отправляем сообщения
            await sendTelegramMessage(chatId, confirmationMessage);
            if (nextQuestion) {
                await sendTelegramMessage(chatId, nextQuestion);
            }
        }
        
        // Обязательный ответ 200 OK для Telegram
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook processing failed (uncaught):', e);
        response.status(500).send('Server Error');
    }
};
