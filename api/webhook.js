import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ SUPABASE И TELEGRAM
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 2. КОНСТАНТЫ КЛАВИАТУРЫ (Классические эмодзи)
const COMPLETED_KEYBOARD = {
    keyboard: [
        [{ text: '✅ Готово' }],
        [{ text: '📊 Мой Прогресс' }, { text: '🏆 Лидерборд' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};
const REMOVE_KEYBOARD = {
    remove_keyboard: true,
};


// 3. НОВАЯ ФУНКЦИЯ: ЗАДЕРЖКА (DELAY)
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 4. ФУНКЦИЯ ДЛЯ ОТВЕТА В TELEGRAM
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

// 5. ФУНКЦИЯ: СТАТУС ПЕЧАТАЕТ...
async function sendChatAction(chatId, action = 'typing') {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            action: action,
        }),
    });
}


// 6. ОСНОВНОЙ ОБРАБОТЧИК (Webhook)
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
    const userFirstName = message.from.first_name || 'друг';

    try {
        // A. Проверка существования пользователя в базе.
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('*')
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
            
            // 1. Вставка нового пользователя
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
            
            // 1.5. Сброс состояния при команде /start
            if (isStartCommand && userData && userData.onboarding_state !== 'STEP_1') {
                 const { error: resetError } = await supabase
                    .from('users')
                    .update({ onboarding_state: 'STEP_1' })
                    .eq('telegram_id', chatId);

                if (resetError) {
                    console.error('Reset State Error:', resetError);
                    await sendTelegramMessage(chatId, `Ошибка сброса статуса: ${resetError.code}.`, 'HTML');
                }
                
                // Удаляем клавиатуру перед онбордингом
                await sendTelegramMessage(chatId, '...', REMOVE_KEYBOARD, 'HTML');
            }
            
            // 2. Отправка первого вопроса 
            const welcomeMessage = `🧠 Привет, *${userFirstName}*. Ты в системе *Квантумных Привычек*.\n\nДаже самое длинное путешествие начинается с подготовки. Твой первый шаг — понять, **Каким ты хочешь стать**?`;
            const step1Question = `*ШАГ 1 из 10: ИДЕНТИЧНОСТЬ.*\n\nКаждое твое действие — это **движение** к твоей новой, усовершенствованной личности.\n\nНапиши, каким человеком ты хочешь стать? (например: _Здоровым и энергичным_, _Продуктивным и организованным_, _Человеком-Системой_)`;


            // ИСПОЛЬЗУЕМ TYPING и DELAY (1000 мс):
            await sendChatAction(chatId, 'typing');
            await delay(1000);
            await sendTelegramMessage(chatId, welcomeMessage);
            
            // ИСПОЛЬЗУЕМ TYPING ПЕРЕД ВТОРЫМ СООБЩЕНИЕМ:
            await sendChatAction(chatId, 'typing');
            await delay(1000);
            await sendTelegramMessage(chatId, step1Question);

        // ===============================================
        // ЛОГИКА 2: ОБРАБОТКА ТЕКСТА (Онбординг и Рабочий Режим)
        // ===============================================
        } else {
            const currentStep = userData.onboarding_state;
            // Удостоверимся, что текст сохраняем до 100 символов, чтобы избежать ошибок.
            const textToSave = incomingText.substring(0, 100);
            let updatePayload = {};
            let confirmationMessage = '';
            let nextQuestion = '';

            // НОВАЯ ЛОГИКА ДЛЯ РАБОЧЕГО РЕЖИМА (COMPLETED)
            if (currentStep === 'COMPLETED') {
                const habitName = userData.habit_micro_step || 'Не указана';
                const identity = userData.desired_identity || 'Не указана';
                
                // Обработка кнопок
                if (incomingText.startsWith('/stats') || incomingText === '📊 Мой Прогресс') {
                    confirmationMessage = `📊 *ТВОЯ СТАТИСТИКА* (В разработке)\n\n*Текущая Привычка:* ${habitName}\n*Идентичность:* ${identity}\n\n*Текущая серия:* 0 дней (Начните логгировать!)\n*Всего голосов за Идентичность:* ${userData.habit_votes_count || 0}\n\nДля полного отчета ожидайте ночной перерасчет.`;
                } else if (incomingText.startsWith('/leaderboard') || incomingText === '🏆 Лидерборд') {
                    confirmationMessage = `🏆 *ЛИДЕРБОРД* (В разработке)\n\nЭта функция покажет ваш ранг среди других пользователей. \n\n_Помните: каждый голос за Идентичность продвигает вас вверх._`;
                } else if (incomingText.startsWith('/done') || incomingText.startsWith('/yes') || incomingText === '✅ Готово') {
                    
                    const newVoteCount = (userData.habit_votes_count || 0) + 1;
                    
                    const { error: voteError } = await supabase
                        .from('users')
                        .update({ habit_votes_count: newVoteCount })
                        .eq('telegram_id', chatId);

                    if (voteError) {
                        confirmationMessage = `Ошибка при логгировании: ${voteError.code}.`;
                    } else {
                        confirmationMessage = `🔥 *ВЫПОЛНЕНО!* 🔥\n\nТвоя привычка: *${habitName}* зачтена.\n\nЭто *${newVoteCount}-й голос* за твою Идентичность: *${identity}*.\n\n_Каждый день ты становишься на 1% лучше._`;
                    }
                } else {
                    confirmationMessage = `Ты уже завершил онбординг! Твоя привычка: ${habitName}. \n\n_Используй кнопки ниже для логгирования или отчета._`;
                }

                nextQuestion = null;
                
                // Отправка сообщения с клавиатурой
                await sendTelegramMessage(chatId, confirmationMessage, COMPLETED_KEYBOARD);
                return response.status(200).send('Processed');

            } else {
                
                // --- ЛОГИКА ОНБОРДИНГА (STEP_1 - STEP_10) ---
                switch (currentStep) {
                    case 'STEP_1':
                        updatePayload = { desired_identity: textToSave, onboarding_state: 'STEP_2' };
                        confirmationMessage = `✅ Принято! Твоя новая Идентичность: *${textToSave}*.\n\nТеперь каждое твое действие будет **движением** к этой цели. Давай выберем *инструмент* для первого шага.`;
                        nextQuestion = "*ШАГ 2 из 10: Что ты будешь делать? (Правило 2 Минут)*\n\nЛюбая новая привычка должна занимать *не больше 120 секунд* в самом ее начале.\n\nНапиши, какую микро-привычку ты готов выполнять ежедневно (например: \"Отжаться 1 раз\", \"Прочитать 1 страницу книги\", \"Выпить стакан воды\").";
                        break;
                    case 'STEP_2':
                        updatePayload = { habit_micro_step: textToSave, onboarding_state: 'STEP_3' };
                        confirmationMessage = `✅ Принято! Твоя новая микро-привычка: *${textToSave}*.\n\nНам нужен лишь **стартовый импульс**, чтобы запустить инерцию.\n\n*Правило 3: Сделай свою новую привычку легкой.*`;
                        // Обновленный текст Шага 3
                        nextQuestion = "*ШАГ 3 из 10: Триггер.*\n\nЛучший способ начать что-то новое — **встроить** его во что-то уже существующее. Мы используем **Связывание привычек** (Habit Stacking).\n\nНапиши, какое ежедневное действие послужит **триггером** для твоей микро-привычки (например: \"После того, как выключу будильник\", \"После того, как почищу зубы\", \"После того, как проверю соцсети\").";
                        break;
                    case 'STEP_3':
                        updatePayload = { habit_link_action: textToSave, onboarding_state: 'STEP_4' };
                        confirmationMessage = `✅ Принято! Ты будешь выполнять привычку **после того, как:** *${textToSave}*.\n\nЭто создаст **триггер**, который невозможно будет пропустить.`;
                        // Обновленный текст Шага 4
                        nextQuestion = "*ШАГ 4 из 10: Чем ты себя наградишь?*\n\nДля завершения цикла привычки (Подсказка -> Действие -> Награда) нужно вознаграждение. Этот сигнал нужен мозгу, чтобы запомнить действие.\n\nНапиши, чем ты себя немедленно наградишь после выполнения микро-привычки (Примеры: \"одну минуту посижу в соцсетях\", \"послушаю хорошую музыку\", \"похвалю себя в зеркало\").";
                        break;
                    case 'STEP_4':
                        updatePayload = { habit_reward: textToSave, onboarding_state: 'STEP_5' };
                        confirmationMessage = `🥳 Отлично! Твоя Награда: *${textToSave}*.\n\nТеперь, когда ты выполнишь привычку, твой мозг **немедленно** получит дофаминовый сигнал. Это закрепит позитивную связь!`;
                        // Обновленный текст Шага 5 (подтверждение Цепочки)
                        nextQuestion = "*ШАГ 5 из 10: Цепочка Прогресса.*\n\nЗакрепление привычки требует не только немедленной награды, но и визуального прогресса. Твоя единственная цель — **не разорвать цепочку**!\n\nНапиши **«Цепочка»**, чтобы подтвердить, что ты готов ежедневно нажимать **✅ Готово** для фиксации своих достижений.";
                        break;
                    case 'STEP_5':
                        // ПРОВЕРКА: Ответ должен быть "ЦЕПОЧКА" (регистр не важен)
                        if (textToSave.toLowerCase() !== 'цепочка') {
                            await sendTelegramMessage(chatId, `Для перехода к следующему шагу необходимо подтверждение. Пожалуйста, напиши **«Цепочка»** (или **«цепочка»**).`);
                            return response.status(200).send('Waiting for confirmation');
                        }

                        // Если ответ "ЦЕПОЧКА", переходим к Шагу 6
                        // Мы не сохраняем текст, только меняем статус
                        updatePayload = { onboarding_state: 'STEP_6' };
                        
                        // Текст подтверждения Шага 5 (с описанием функционала)
                        confirmationMessage = `Отлично! Ты готов создать серию. \n\n**ФУНКЦИОНАЛ ТРЕКЕРА:** При нажатии **✅ Готово** (или отправке команды **\`/done\`**) бот будет:\n1. Фиксировать **голос** за твою Идентичность.\n2. Обновлять **цепочку** (streak).\n\nНачинаем финальный этап настройки!`;
                        
                        // Обновленный текст Шага 6
                        nextQuestion = "*ШАГ 6 из 10: Как ты назовешь привычку для статистики?*\n\nДля удобства в статистике нужно ключевое слово, или короткая, легко узнаваемая фраза.\n\nНапиши название своей новой привычки.";
                        break;
                    case 'STEP_6':
                        updatePayload = { habit_identifier: textToSave, onboarding_state: 'STEP_7' };
                        confirmationMessage = `Идентификатор: *${textToSave}*.\n\nТеперь, когда ты увидишь этот ID, ты точно будешь знать, что нужно отметить.`;
                        
                        // Обновленный текст Шага 7
                        nextQuestion = "*ШАГ 7 из 10: Провалы*\n\nПланировать нужно не только результаты, но и возможные провалы. Как ты думаешь, что может тебе помешать выполнить привычку?\n\nНапиши одно самое вероятное препятствие (например: \"Усталость после работы\", \"Забуду о привычке\", \"Не хватит времени\").";
                        break;
                    case 'STEP_7':
                        updatePayload = { obstacle_plan_1: textToSave, onboarding_state: 'STEP_8' };
                        confirmationMessage = `Препятствие определено: *${textToSave}*.\n\nМы готовы к борьбе.`;
                        
                        // Обновленный текст Шага 8
                        nextQuestion = `*ШАГ 8 из 10: План преодоления?*\n\nЕсли возникнет *${textToSave}*, то что ты сделаешь?\n\nНапиши план (например: "Если устану после работы, сделаю отжимание сразу после того, как приду домой", "Если забуду, поставлю будильник на 17:00").`;
                        break;
                    case 'STEP_8':
                        updatePayload = { obstacle_plan_2: textToSave, onboarding_state: 'STEP_9' };
                        // Обновленное подтверждение Шага 8
                        confirmationMessage = `План преодоления: *${textToSave}*.\n\nТы подготовил себя к успеху. Больше не нужно полагаться **только** на мотивацию.`;
                        
                        // Обновленный текст Шага 9
                        nextQuestion = "*ШАГ 9 из 10: Никогда не пропускай привычку *дважды подряд*. Это самое главное правило.\n\nНапиши, как ты гарантированно вернешься к привычке после одного пропуска (например: \"Начну со второй половины дня\", \"Сделаю ее сразу же, как вспомню, независимо от времени\").";
                        break;
                    case 'STEP_9':
                        updatePayload = { failure_plan: textToSave, onboarding_state: 'STEP_10' };
                        // Подтверждение Шага 9
                        confirmationMessage = `Правило при пропуске: *${textToSave}*.\n\nЭто защищает тебя от срыва. Один пропуск - случайность. Два - начало новой, плохой привычки.`;
                        
                        // ИСПРАВЛЕНО: Новый текст Шага 10 (Сфокусирован на дедлайнах и формате)
                        nextQuestion = "*ШАГ 10 из 10: Установка дедлайнов*\n\nЧтобы я мог отправлять тебе напоминания и собирать статистику, нужно установить регулярные дедлайны.\n\nНапиши точное время, когда ты планируешь выполнять привычку (например: **18:30** или **08:00**).";
                        break;
                    case 'STEP_10':
                        // Финальный шаг!
                        updatePayload = { repetition_schedule: textToSave, onboarding_state: 'COMPLETED' };
                        
                        const { error: updateErrorStep10 } = await supabase
                            .from('users')
                            .update(updatePayload)
                            .eq('telegram_id', chatId);

                        if (updateErrorStep10) {
                            console.error(`Update Error (STEP_10):`, updateErrorStep10);
                            await sendTelegramMessage(chatId, `Ошибка БД (UPDATE). Код: ${updateErrorStep10.code}.`, 'HTML');
                            return response.status(500).send('Database Update Error');
                        }
                        
                        // ВАЖНО: Получаем актуальные данные для финальной сводки
                        const finalData = { ...userData, ...updatePayload };

                        // 3. Составляем финальное сообщение
                        confirmationMessage = `🎉 *ОНБОРДИНГ ЗАВЕРШЕН!* 🎉\n\n**Поздравляю!** Ты создал *Квантовую Привычку*. Я буду отправлять тебе напоминания в *${textToSave}*.\n\n---
*Твоя Полная Формула:*\n
*Идентичность:* ${finalData.desired_identity || 'Не указана'}
*Микро-Привычка:* ${finalData.habit_micro_step || 'Не указана'}
*Триггер (Связка):* ${finalData.habit_link_action || 'Не указана'}
*Награда (Дофамин):* ${finalData.habit_reward || 'Не указана'}
*Идентификатор:* ${finalData.habit_identifier || 'Не указан'}
*План при пропуске:* ${finalData.failure_plan || 'Не указан'}
---

*Начни сейчас:* Выполни *${finalData.habit_micro_step || 'Не указана'}* **сразу после** *${finalData.habit_link_action || 'Не указано'}*. \n\nПосле выполнения нажми **✅ Готово**!`;
                        nextQuestion = null;
                        
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
            
            // Отправка сообщений в онбординге (с использованием TYPING и DELAY)
            if (currentStep !== 'STEP_10') {
                await sendChatAction(chatId, 'typing');
                await delay(1000); // 1.0s пауза
                await sendTelegramMessage(chatId, confirmationMessage);
                if (nextQuestion) {
                    await sendChatAction(chatId, 'typing');
                    await delay(1000); // 1.0s пауза
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
