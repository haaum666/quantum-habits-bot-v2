import { createClient } from '@supabase/supabase-js';

// 1. КОНФИГУРАЦИЯ
const SUPABASE_URL = process.env.BOT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 2. КЛАВИАТУРА ДЛЯ НАПОМИНАНИЯ
const REMINDER_KEYBOARD = {
    keyboard: [
        [{ text: '✅ Готово' }],
        [{ text: '📊 Мой Прогресс' }, { text: '🏆 Лидерборд' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
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

// 4. ГЛАВНАЯ ФУНКЦИЯ CRON JOB
export default async (request, response) => {
    // Безопасность: Проверка токена (если используется внешний Cron)
    // if (request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    //     return response.status(401).json({ success: false, message: 'Unauthorized' });
    // }
    
    // --- 4.1. Определение текущего времени (для сравнения с БД) ---
    // Мы берем время в UTC, чтобы избежать проблем с часовыми поясами. 
    // Предполагаем, что пользователь ввел время в своем локальном часовом поясе.
    // Если вам нужна абсолютная точность, нужно хранить TZ-информацию. 
    // Для простоты сравниваем "HH:MM".
    
    const now = new Date();
    // Форматируем текущее время в HH:MM (например, "09:25")
    // Используем смещение, чтобы приблизить к московскому времени (UTC+3) 
    // (Подразумеваем, что большинство пользователей вводят время по МСК)
    const moscowOffset = 3 * 60 * 60 * 1000; // 3 часа в миллисекундах
    const moscowTime = new Date(now.getTime() + moscowOffset);
    
    // Получаем часы и минуты в формате HH:MM
    const currentHour = String(moscowTime.getHours()).padStart(2, '0');
    const currentMinute = String(moscowTime.getMinutes()).padStart(2, '0');
    const currentTime = `${currentHour}:${currentMinute}`; 
    
    // Получаем текущую дату в формате YYYY-MM-DD для проверки логов
    const today = moscowTime.toISOString().split('T')[0];
    
    console.log(`[CRON] Running at (MSK assumed): ${currentTime}. Check date: ${today}`);


    // --- 4.2. Поиск пользователей, чье время напоминания пришло (или было пропущено) ---
    const { data: users, error: userError } = await supabase
        .from('users')
        .select('telegram_id, habit_micro_step, desired_identity, repetition_schedule')
        .eq('onboarding_state', 'COMPLETED')
        // Ищем совпадение по часу и минутам. Мы ищем только тех, 
        // у кого время совпадает с текущим временем
        .eq('repetition_schedule', currentTime) 
        .not('repetition_schedule', 'is', null);

    if (userError) {
        console.error('Supabase User Fetch Error:', userError);
        return response.status(500).json({ success: false, message: 'Database fetch error' });
    }

    let usersNotified = 0;
    
    // --- 4.3. Проверка логов и отправка напоминаний ---
    for (const user of users) {
        
        // Проверка: Выполнил ли пользователь привычку сегодня?
        const { count: logCount, error: logError } = await supabase
            .from('habit_logs')
            .select('*', { count: 'exact', head: true })
            .eq('telegram_id', user.telegram_id)
            // Ищем логи, выполненные СЕГОДНЯ (сегодня = дата из today)
            .gte('completed_at', today); 

        if (logError) {
            console.error(`Log Check Error for user ${user.telegram_id}:`, logError);
            continue; // Игнорируем этого пользователя и переходим к следующему
        }

        // Если логов сегодня нет, отправляем напоминание
        if (logCount === 0) {
            
            const reminderText = `🔔 *КВАНТУМНОЕ НАПОМИНАНИЕ!* 🔔\n\nПришло время выполнить твою микро-привычку: *${user.habit_micro_step}*.\n\n_Помни: каждый раз, когда ты делаешь это, ты голосуешь за свою Идентичность: стать ${user.desired_identity}_. \n\n*Нажми "✅ Готово", как только выполнишь.*`;
            
            await sendTelegramMessage(user.telegram_id, reminderText, REMINDER_KEYBOARD);
            usersNotified++;
        }
    }

    return response.status(200).json({ 
        success: true, 
        message: 'Reminder check completed', 
        users_found: users.length,
        users_notified: usersNotified,
        time_checked: currentTime
    });
};
