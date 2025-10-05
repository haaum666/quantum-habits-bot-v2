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
            const welcomeMessage = `🧠 Привет, *${userFirstName}*. Ты в системе *Квантумных Привычек*.\n\nДаже самое длинное путешествие начинается с подготовки. Сперва выбери направление.`;
            // ИСПРАВЛЕНО: Нумерация
            const step1Question = `*ШАГ 1 из 9: Идентичность.*\n\nКаждое действие — это *движение* к твоей новой, усовершенствованной личности.\n\n*Напиши, каким человеком ты хочешь стать?* \n\n_Например:_ _здоровым и энергичным_, _продуктивным и организованным_, _или_ _человеком-системой_)`;


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
                
                // --- ЛОГИКА ОНБОРДИНГА (STEP_1 - STEP_9) ---
                switch (currentStep) {
                    case 'STEP_1':
                        updatePayload = { desired_identity: textToSave, onboarding_state: 'STEP_2' };
                        // ИСПРАВЛЕНО: Нумерация
                        confirmationMessage = `✅ Принято! Твоя цель — *стать ${textToSave}*.\n\nТеперь каждое твое действие будет *движением* к этой цели. Давай *выберем инструмент* для следующего шага.`;
                        // ИСПРАВЛЕНО: Нумерация
                        nextQuestion = `*ШАГ 2 из 9: Действие.*\n\nЛюбая новая привычка должна занимать *не более 120 секунд* в самом ее начале.\n\nНапиши, какую микро-привычку ты готов выполнять *ежедневно?* \n\n_Например:_ \_отжаться 1 раз_\, \_прочитать 1 страницу сложной книги_\, \_выпить стакан воды\_).`;
                        break;
                    case 'STEP_2':
                        updatePayload = { habit_micro_step: textToSave, onboarding_state: 'STEP_3' };
                        confirmationMessage = `✅ Принято! Твоя новая микро-привычка: *${textToSave}*.\n\nНам нужен лишь *стартовый импульс*, чтобы запустить инерцию.\n\n*Правило 3: Сделай свою новую привычку легкой.*`;
                        // ИСПРАВЛЕНО: Нумерация
                        nextQuestion = `*ШАГ 3 из 9: Триггер.*\n\nЛучший способ начать что-то новое — *встроить это во что-то уже существующее*. Мы используем *Habit Stacking* (связывание привычек).\n\n*Напиши, какое ежедневное действие послужит триггером для твоей микро-привычки*. \n\nНапример: \_выключение будильника_\, \_чистка зубов_\, \_утренняя проверка соцсетей_\).`;
                        break;
                    case 'STEP_3':
                        updatePayload = { habit_link_action: textToSave, onboarding_state: 'STEP_4' };
                        confirmationMessage = `✅ Принято! Твой триггер зафиксирован: *${textToSave}!*`;
                        // ИСПРАВЛЕНО: Нумерация
                        nextQuestion = `*ШАГ 4 из 9: Награда.*\n\nЧтобы завершить цикл привычки: *_подсказка -> действие -> награда_*, мозгу нужен дофаминовый сигнал. \n\n**Вознаграждение** — это ключ к закреплению позитивной связи.\n\n*Напиши, чем ты готов немедленно наградить себя после выполнения микро-привычки? \n\n_Например: посмотрю рилсы одну минутку, послушаю хорошую музыку, похвалю себя в зеркало_.`;
                        break;
                    case 'STEP_4':
                        updatePayload = { habit_reward: textToSave, onboarding_state: 'STEP_5' };
                        confirmationMessage = `✅ Принято! Это твой дофаминовый стимул: *${textToSave}*.\n\nТеперь, каждый раз когда ты выполняешь привычку, твой мозг закрепляет позитивную связь!`;
                        // ИСПРАВЛЕНО: Нумерация
                        nextQuestion = `*ШАГ 5 из 9: Прогресс.*\n\nЗакрепление привычки требует не только немедленной награды, но и визуализации промежуточных достижений.\n\nКогда ты нажимаешь кнопку: *✅ Готово* или пишешь \`/done\` - бот фиксирует *streak* _успешную серию_.\n\n*Твоя цель — не прерывать эту серию*.\n\nНапиши *прогресс*, чтобы подтвердить, что ты готов регулярно фиксировать свои достижения.`;
                        break;
                    case 'STEP_5':
                        // ПРОВЕРКА: Ответ должен быть "Прогресс" (регистр не важен)
                        if (textToSave.toLowerCase() !== 'прогресс') {
                            await sendTelegramMessage(chatId, `Для перехода к следующему шагу необходимо подтверждение. Пожалуйста, *напиши Прогресс (или прогресс).`);
                            return response.status(200).send('Waiting for confirmation');
                        }

                        // Если ответ "Прогресс", переходим к Шагу 6
                        updatePayload = { onboarding_state: 'STEP_6' };
                        
                        // Текст подтверждения Шага 5 (с описанием функционала)
                        confirmationMessage = `*Отлично! Ты готов создать серию*. \n\n*функционал трекера:* при нажатии кнопки *✅ Готово* (или отправке команды \`/done\`) бот будет Фиксировать *голос* за твою Идентичность и обновлять *streak* _успешную серию_.\n\nНачинаем финальный этап настройки!`;
                        
                        // ИСПРАВЛЕНО: Нумерация
                        nextQuestion = "*ШАГ 6 из 9: Название привычки* \n\nДля твоего удобства и отображения в общей статистике нужно ключевое слово, или короткая, легко узнаваемая фраза.\n\nНапиши название своей новой привычки.";
                        break;
                    case 'STEP_6':
                        // ИСПРАВЛЕНО: Переход на STEP_7
                        updatePayload = { habit_identifier: textToSave, onboarding_state: 'STEP_7' };
                        confirmationMessage = `✅ Принято! Идентификатор твоей новой привычки: *${textToSave}*.`;
                        
                        // НОВЫЙ Шаг 7 (Объединенный: Преодоление) - Ваша формулировка + Нумерация
                        nextQuestion = `*ШАГ 7 из 9: План Преодоления*\n\nПланировать нужно не только результаты, но и возможные провалы.\n\nНапиши **главное препятствие** И **твои действия**, если оно возникнет. (Используй формат "Если... то...").\n\nНапример: _Если устану, сделаю отжимание сразу, как приду домой_.`;
                        break;
                    case 'STEP_7':
                        // ИСПРАВЛЕНО: Сохраняем объединенный план в obstacle_plan_1 и переходим на STEP_8
                        updatePayload = { obstacle_plan_1: textToSave, onboarding_state: 'STEP_8' }; 
                        confirmationMessage = `✅ Принято! План преодоления зафиксирован: *${textToSave}*.\n\n**Ты подготовил себя к успеху!**`;
                        
                        // НОВЫЙ Шаг 8 (Бывший Шаг 9: План Возврата) - Ваша формулировка + Нумерация
                        nextQuestion = `*ШАГ 8 из 9: Правило при пропуске*\n\nЭто самое главное правило: **никогда не пропускай привычку дважды подряд**.\n\nНапиши, как ты гарантированно вернешься к привычке после одного пропуска (например: \_Начну со второй половины дня_, \_Сделаю ее сразу же, как вспомню, независимо от времени\_).`;
                        break;
                    case 'STEP_8':
                        // ИСПРАВЛЕНО: Сохраняем failure_plan и переходим к STEP_9 (Бывший STEP_10)
                        updatePayload = { failure_plan: textToSave, onboarding_state: 'STEP_9' };
                        // ИСПРАВЛЕНО: Унификация подтверждения
                        confirmationMessage = `✅ Принято! План возврата: *${textToSave}*.\n\nЭто защищает тебя от срыва. _Один пропуск - случайность. Два - начало плохой привычки._`;
                        
                        // НОВЫЙ Шаг 9 (Бывший Шаг 10: Дедлайны) - Ваша формулировка + Нумерация
                        nextQuestion = "*ШАГ 9 из 9: Установка Дедлайнов*\n\nЧтобы я мог отправлять тебе напоминания и собирать статистику, нужно установить регулярные дедлайны.\n\nНапиши точное время, когда ты планируешь выполнять привычку (например: **18:30** или **08:00**).";
                        break;
                    case 'STEP_9':
                        // ФИНАЛЬНЫЙ ШАГ (Бывший STEP_10)!
                        updatePayload = { repetition_schedule: textToSave, onboarding_state: 'COMPLETED' };
                        
                        const { error: updateErrorStep9 } = await supabase
                            .from('users')
                            .update(updatePayload)
                            .eq('telegram_id', chatId);

                        if (updateErrorStep9) {
                            console.error(`Update Error (STEP_9):`, updateErrorStep9);
                            await sendTelegramMessage(chatId, `Ошибка БД (UPDATE). Код: ${updateErrorStep9.code}.`, 'HTML');
                            return response.status(500).send('Database Update Error');
                        }
                        
                        // ВАЖНО: Получаем актуальные данные для финальной сводки
                        const finalData = { ...userData, ...updatePayload };

                        // 3. Составляем финальное сообщение (Скорректировано, чтобы исключить obstacle_plan_2)
                        confirmationMessage = `🎉 *ОНБОРДИНГ ЗАВЕРШЕН!* 🎉\n\n**Поздравляю!** Ты создал *Квантовую Привычку*. Я буду отправлять тебе напоминания в *${textToSave}*.\n\n---
*Твоя Полная Формула:*\n
*Идентичность:* ${finalData.desired_identity || 'Не указана'}
*Микро-Привычка:* ${finalData.habit_micro_step || 'Не указана'}
*Триггер (Связка):* ${finalData.habit_link_action || 'Не указана'}
*Награда (Дофамин):* ${finalData.habit_reward || 'Не указана'}
*Идентификатор:* ${finalData.habit_identifier || 'Не указан'}
*План преодоления:* ${finalData.obstacle_plan_1 || 'Не указан'} 
*План возврата:* ${finalData.failure_plan || 'Не указан'}
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
            
            // Если мы не в состоянии 'COMPLETED' и не в 'STEP_9' (бывший STEP_10), пытаемся обновить БД
            if (currentStep !== 'STEP_9' && currentStep !== 'COMPLETED') {
                
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
            if (currentStep !== 'STEP_9') {
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
