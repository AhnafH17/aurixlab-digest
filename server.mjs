import pg from 'pg';
import http from 'http';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || 'aurixlab-secret';

// ── Fetch data from Supabase ───────────────────────────────────────────────
async function fetchWorkloadData() {
  const client = await pool.connect();
  try {
    const usersResult = await client.query(
      `SELECT id, name, username FROM users WHERE disabled = false ORDER BY name ASC`
    );
    const activeResult = await client.query(
      `SELECT id, title, priority, due_date, assignee_id, assignee_ids
       FROM tasks WHERE done_date IS NULL AND deleted_at IS NULL`
    );
    const doneResult = await client.query(
      `SELECT id, assignee_id, assignee_ids
       FROM tasks WHERE done_date IS NOT NULL AND deleted_at IS NULL`
    );

    const now = new Date();
    const fiveDaysFromNow = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const getAssigneeIds = (task) => {
      const ids = [];
      if (task.assignee_id) ids.push(task.assignee_id);
      const multi = Array.isArray(task.assignee_ids)
        ? task.assignee_ids
        : typeof task.assignee_ids === 'string' && task.assignee_ids !== '[]'
        ? JSON.parse(task.assignee_ids)
        : [];
      for (const id of multi) {
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    };

    const userMap = {};
    for (const user of usersResult.rows) {
      userMap[user.id] = { name: user.name, username: user.username, activeTasks: [], doneTasks: 0 };
    }
    for (const task of activeResult.rows) {
      for (const uid of getAssigneeIds(task)) {
        if (userMap[uid]) {
          userMap[uid].activeTasks.push({
            title: task.title,
            priority: task.priority,
            dueDate: task.due_date ? new Date(task.due_date) : null,
          });
        }
      }
    }
    for (const task of doneResult.rows) {
      for (const uid of getAssigneeIds(task)) {
        if (userMap[uid]) userMap[uid].doneTasks++;
      }
    }

    const totalActive = Object.values(userMap).reduce((sum, u) => sum + u.activeTasks.length, 0);
    const activeMembers = Object.values(userMap).filter(u => u.activeTasks.length > 0);
    const avgTasks = activeMembers.length > 0 ? totalActive / activeMembers.length : 0;

    const workload = Object.values(userMap)
      .map((data) => {
        const active = data.activeTasks;
        const count = active.length;
        const pct = totalActive > 0 ? ((count / totalActive) * 100).toFixed(1) : '0.0';
        const isBottleneck = count > 0 && avgTasks > 0 && count >= avgTasks * 2;
        return {
          name: data.name,
          activeTasks: count,
          doneTasks: data.doneTasks,
          workloadPercent: pct,
          isBottleneck,
          overdueTasks: active.filter(t => t.dueDate && t.dueDate < now).map(t => ({
            title: t.title,
            dueDate: t.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          })),
          urgentTasks: active.filter(t => t.priority === 'URGENT').map(t => ({ title: t.title })),
          dueSoonTasks: active.filter(t => t.dueDate && t.dueDate >= now && t.dueDate <= fiveDaysFromNow).map(t => ({
            title: t.title,
            dueDate: t.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          })),
        };
      })
      .filter(u => u.activeTasks > 0)
      .sort((a, b) => b.activeTasks - a.activeTasks);

    return { totalActive, avgTasks: avgTasks.toFixed(1), workload };
  } finally {
    client.release();
  }
}

// ── Ask Gemini to write the Discord message ────────────────────────────────
async function generateWithGemini(data) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const bottlenecks = data.workload.filter(u => u.isBottleneck);

  const prompt = `You are writing a daily team workload digest for a Discord channel. The CEO reads this every morning.

Write a Discord message using EXACTLY this format and structure. Use Discord markdown only (bold with **, quote blocks with >, no HTML):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊  **AURIXLAB DAILY BRIEF**  |  ${today}
     ${data.totalActive} active tasks · avg ${data.avgTasks} per member
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For each team member below, write one block. Use > for indented lines. List ALL overdue and urgent tasks by name. Be specific and concise.

Here is the raw data:
${JSON.stringify(data.workload, null, 2)}

Rules:
- For each person: show 👤 **Name** — X active | X done | X%
- Show overdue tasks as: > ⚠️ **Overdue (N):** task name (date), task name (date)
- Show urgent tasks as: > 🔴 **Urgent (N):** task name, task name
- Show due-soon tasks as: > 📅 **Due next 5 days (N):** task name (date)
- Skip a category if count is 0
- After all members, add a separator ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${bottlenecks.length > 0
  ? `- End with: 🚨 **BOTTLENECK: ${bottlenecks.map(b => `${b.name} at ${b.workloadPercent}% — 2x above average. Needs immediate redistribution.`).join(' | ')}**`
  : '- No bottleneck this time, end with: ✅ **Workload is balanced across the team.**'
}
- Do not add any commentary, explanation, or text outside the format above.
- Keep the total message under 1800 characters. If too long, truncate task lists with "...and N more".`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${err}`);
  }

  const json = await response.json();
  return json.candidates[0].content.parts[0].text.trim();
}

// ── Post to Discord (split if over 2000 chars) ────────────────────────────
async function postToDiscord(message) {
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    if ((current + line + '\n').length > 1900) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);

  for (const chunk of chunks) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk, username: 'Aurixlab Digest' }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord error: ${res.status} — ${err}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main digest runner ────────────────────────────────────────────────────
async function runDigest() {
  console.log(`[${new Date().toISOString()}] Running digest...`);
  const data = await fetchWorkloadData();
  const message = await generateWithGemini(data);
  await postToDiscord(message);
  console.log(`[${new Date().toISOString()}] Digest posted successfully.`);
}

// ── HTTP server (Render needs a port to stay alive) ───────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (req.method === 'POST' && req.url === '/run-digest') {
    const secret = req.headers['x-cron-secret'];
    if (secret !== CRON_SECRET) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200);
    res.end('Digest started');
    runDigest().catch(err => console.error('Digest error:', err));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Aurixlab digest server running on port ${PORT}`);
});
