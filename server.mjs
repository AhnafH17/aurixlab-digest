import pg from 'pg';
import http from 'http';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
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

// ── Build Discord message from workload data ──────────────────────────────
function buildMessage(data) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const chunks = [];

  // Header
  let header = `📊 **AURIXLAB DAILY BRIEF** | ${dateStr}\n`;
  header += `**${data.totalActive} active tasks across the team**\n`;
  chunks.push(header);

  // One block per person
  for (const u of data.workload) {
    let block = `\n👤 **${u.name}**\n`;
    block += `\`\`\`\n`;
    block += `Active: ${u.activeTasks}   Done: ${u.doneTasks}   Urgent: ${u.urgentTasks.length}   Due soon: ${u.dueSoonTasks.length}   Overdue: ${u.overdueTasks.length}\n`;
    block += `\`\`\``;

    const hasDetails = u.overdueTasks.length > 0 || u.urgentTasks.length > 0 || u.dueSoonTasks.length > 0;
    if (hasDetails) {
      let details = '';
      if (u.overdueTasks.length > 0) {
        details += `⚠️ Overdue (${u.overdueTasks.length}):\n`;
        details += u.overdueTasks.map((t, i) => `  ${i + 1}. ${t.title} (${t.dueDate})`).join('\n') + '\n\n';
      }
      if (u.urgentTasks.length > 0) {
        details += `🔴 Urgent (${u.urgentTasks.length}):\n`;
        details += u.urgentTasks.map((t, i) => `  ${i + 1}. ${t.title}`).join('\n') + '\n\n';
      }
      if (u.dueSoonTasks.length > 0) {
        details += `📅 Due next 5 days (${u.dueSoonTasks.length}):\n`;
        details += u.dueSoonTasks.map((t, i) => `  ${i + 1}. ${t.title} (${t.dueDate})`).join('\n') + '\n';
      }
      block += `\`\`\`\n${details.trim()}\n\`\`\``;
    }

    chunks.push(block);
  }

  return chunks;
}

// ── Post to Discord ───────────────────────────────────────────────────────
async function postToDiscord(chunks) {
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
  const message = buildMessage(data);
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
