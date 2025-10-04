// api/webhook.js

import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ SUPABASE И TELEGRAM
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); 
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 2. КОНСТАНТЫ КЛАВИАТУРЫ
// ReplyKeyboard обеспечивает скрытие/восстановление через иконку
const COMPLETED_KEYBOARD = {
    keyboard: [
        [{ text: '✔ Готово' }], // Первая строка: самое частое действие
        [{ text: '⏣ Мой Прогресс' }, { text: '⚜️ Лидерборд' }] // Вторая строка: отчеты
    ],
    resize_keyboard: true, // Делает клавиатуру компактной
    one_time_keyboard: false, // Клавиатура не исчезнет после нажатия
};
// Клавиатура для удаления меню, если понадобится
const REMOVE_KEYBOARD = {
    remove_keyboard: true,
};


// 3. ФУНКЦИЯ ДЛЯ ОТВЕТА В TELEGRAM
async function sendTelegramMessage(chatId, text, keyboard = null, parse_mode = 'Markdown') {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: parse_mode, 
    };

    if (keyboard) {
        payload.reply_markup = keyboard;
    }

    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        console.error(`Telegram API Error: ${await response.text()}`);
    }
    return response.json();
}

// 4. ОСНОВНОЙ ОБРАБОТЧИК (Webhook)
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
        // A. Проверка существования пользователя в базе.
        const { data: userData, error: userError } = await supabase
            .from('users') 
            .select('*') // Загружаем все поля
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
            
            // 1. Вставка нового пользователя (только если не существует)
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
            
            // 1.5. ИСПРАВЛЕНИЕ: Сброс состояния при команде /start, если пользователь уже существует
            if (isStartCommand && userData && userData.onboarding_state !== 'STEP_1') {
                 const { error: resetError } = await supabase
                    .from('users')
                    .update({ onboarding_state: 'STEP_1' })
                    .eq('telegram_id', chatId);

                if (resetError) {
                    console.error('Reset State Error:', resetError);
                    await sendTelegramMessage(chatId, `Ошибка сброса статуса: ${resetError.code}.`, 'HTML');
                }
                
                // Удаляем клавиатуру перед онбордингом, чтобы не мешала
                await sendTelegramMessage(chatId, '...', REMOVE_KEYBOARD, 'HTML');
            }
            
            // 2. Отправка первого вопроса
            const welcomeMessage = `👋 *Привет!* Я твой личный бот-помощник по методу \"Атомных Привычек\".\n\nЯ помогу тебе строить системы, которые приведут к 1% улучшению каждый день. \n\nДавай начнем с главного.`;
            await sendTelegramMessage(chatId, welcomeMessage);
            
            await sendTelegramMessage(chatId, "*ШАГ 1 из 10: КЕМ ты хочешь стать?*\n\nВся сила в Идентичности. Напиши, кем ты хочешь стать благодаря своим привычкам (например: \"Здоровым и энергичным\", \"Продуктивным и организованным\", \"Образованным и развитым\").");

        // ===============================================
        // ЛОГИКА 2: ОБРАБОТКА ТЕКСТА (Онбординг и Рабочий Режим)
        // ===============================================
        } else {
            const currentStep = userData.onboarding_state;
            const textToSave = incomingText.substring(0, 100);
            let updatePayload = {};
            let confirmationMessage = '';
            let nextQuestion = '';

            // НОВАЯ ЛОГИКА ДЛЯ РАБОЧЕГО РЕЖИМА (COMPLETED)
            if (currentStep === 'COMPLETED') {
                const habitName = userData.habit_micro_step || 'Не указана';
                const identity = userData.desired_identity || 'Не указана';
                
                // 1. КОМАНДА /stats или КНОПКА
                if (incomingText.startsWith('/stats') || incomingText === '⏣ Мой Прогресс') {
                    
                    confirmationMessage = `📊 *ТВОЯ СТАТИСТИКА* (В разработке)\n\n*Текущая Привычка:* ${habitName}\n*Идентичность:* ${identity}\n\n*Текущая серия:* 0 дней (Начните логгировать!)\n*Всего голосов за Идентичность:* ${userData.habit_votes_count || 0}\n\nДля полного отчета ожидайте ночной перерасчет.`;
                    
                // 2. КОМАНДА /leaderboard или КНОПКА
                } else if (incomingText.startsWith('/leaderboard') || incomingText === '⚜️ Лидерборд') { 
    
                    confirmationMessage = `🏆 *ЛИДЕРБОРД* (В разработке)\n\nЭта функция покажет ваш ранг среди других пользователей. \n\n_Помните: каждый голос за Идентичность продвигает вас вверх._`;

                // 3. КОМАНДА /done (Логгирование) или КНОПКА
                } else if (incomingText.startsWith('/done') || incomingText.startsWith('/yes') || incomingText === '✔ Готово') {
                    
                    const newVoteCount = (userData.habit_votes_count || 0) + 1;
                    
                    const { error: voteError } = await supabase
                        .from('users')
                        .update({ 
                            habit_votes_count: newVoteCount,
                        })
                        .eq('telegram_id', chatId);

                    if (voteError) {
                        console.error('Vote Error:', voteError);
                        confirmationMessage = `Ошибка при логгировании: ${voteError.code}.`;
                    } else {
                        confirmationMessage = `🔥 *ВЫПОЛНЕНО!* 🔥\n\nТвоя привычка: *${habitName}* зачтена.\n\nЭто *${newVoteCount}-й голос* за твою Идентичность: *${identity}*.\n\n_Каждый день ты становишься на 1% лучше._`;
                    }
                
                // 4. ОБЫЧНЫЙ ТЕКСТ (Повторение статуса)
                } else {
                    confirmationMessage = `Ты уже завершил онбординг! Твоя привычка: ${habitName}. \n\n_Используй кнопки ниже для логгирования или отчета._`;
                }

                nextQuestion = null;
                
                // ЛОГИКА ОТПРАВКИ КЛАВИАТУРЫ
                await sendTelegramMessage(chatId, confirmationMessage, COMPLETED_KEYBOARD);
                return response.status(200).send('Processed');

            } else {
                
                // --- ЛОГИКА ОНБОРДИНГА (STEP_1 - STEP_10) ---
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
                        
                        // 1. Обновляем БД (как обычно)
                        const { error: updateErrorStep10 } = await supabase
                            .from('users')
                            .update(updatePayload)
                            .eq('telegram_id', chatId);

                        if (updateErrorStep10) {
                            console.error(`Update Error (STEP_10):`, updateErrorStep10);
                            await sendTelegramMessage(chatId, `Ошибка БД (UPDATE). Код: ${updateErrorStep10.code}.`, 'HTML');
                            return response.status(500).send('Database Update Error');
                        }
                        
                        // 2. Используем текущий объект userData, который был загружен,
                        // и просто обновляем его из памяти для финального сообщения
                        const finalData = { ...userData, ...updatePayload };

                        // 3. Составляем финальное сообщение
                        confirmationMessage = `🎉 *ОБОРДИНГ ЗАВЕРШЕН!* 🎉\n\nТы готов! Я буду отправлять тебе напоминания в *${textToSave}*.\n\nТвоя полная формула:\n*Идентичность:* ${finalData.desired_identity || 'Не указана'}\n*Привычка:* ${finalData.habit_micro_step || 'Не указана'}\n*Связка:* ${finalData.habit_link_action || 'Не указана'}\n*Награда:* ${finalData.habit_reward || 'Не указана'}\n*Трекер:* ${finalData.habit_tracker || 'Не указан'}\n\n*Начни сейчас:* Твоя первая привычка: ${finalData.habit_micro_step || 'Не указана'} СРАЗУ ПОСЛЕ ${finalData.habit_link_action || 'Не указано'}.`;
                        nextQuestion = null;
                        
                        // ОТПРАВКА С КЛАВИАТУРОЙ!
                        await sendTelegramMessage(chatId, confirmationMessage, COMPLETED_KEYBOARD);
                        return response.status(200).send('Processed');

                    default:
                        confirmationMessage = `Ошибка! Неизвестный статус онбординга: *${currentStep}*.\n\nНапиши /start, чтобы начать заново.`;
                        nextQuestion = null;
                }
            }
            
            // Если мы не в состоянии 'COMPLETED' и не в 'STEP_10', пытаемся обновить БД
            if (currentStep !== 'STEP_10' && currentStep !== 'COMPLETED') { 
                
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
            
            // Отправка сообщений в онбординге (кроме STEP_10, который обрабатывается выше)
            if (currentStep !== 'STEP_10') {
                await sendTelegramMessage(chatId, confirmationMessage);
                if (nextQuestion) {
                    await sendTelegramMessage(chatId, nextQuestion);
                }
            }
        }
        
        response.status(200).send('Processed');

    } catch (e) {
        console.error('Webhook processing failed (uncaught):', e);
        response.status(500).send('Server Error');
    }
};
