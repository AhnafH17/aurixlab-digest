import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

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
      const overdueTasks = active.filter(t => t.dueDate && t.dueDate < now);
      const urgentTasks = active.filter(t => t.priority === 'URGENT');
      const dueSoonTasks = active.filter(t => t.dueDate && t.dueDate >= now && t.dueDate <= fiveDaysFromNow);
      return { name: data.name, count, done: data.doneTasks, pct, isBottleneck, overdueTasks, urgentTasks, dueSoonTasks };
    })
    .filter(u => u.count > 0)
    .sort((a, b) => b.count - a.count);

  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  let msg = `📊 **Aurixlab Team Brief — ${dateStr}** | ${totalActive} active tasks\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const u of workload) {
    msg += `👤 **${u.name}** — ${u.count} active | ${u.done} done | ${u.pct}%\n`;
    if (u.overdueTasks.length > 0) {
      msg += `> ⚠️ Overdue: ${u.overdueTasks.map(t => `${t.title} (${t.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`).join(', ')}\n`;
    }
    if (u.urgentTasks.length > 0) {
      msg += `> 🔴 Urgent: ${u.urgentTasks.map(t => t.title).join(', ')}\n`;
    }
    if (u.dueSoonTasks.length > 0) {
      msg += `> 📅 Due soon: ${u.dueSoonTasks.map(t => `${t.title} (${t.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`).join(', ')}\n`;
    }
    msg += '\n';
  }

  const bottlenecks = workload.filter(u => u.isBottleneck);
  if (bottlenecks.length > 0) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const b of bottlenecks) {
      msg += `🚨 **BOTTLENECK: ${b.name} carrying ${b.pct}% of workload — immediate attention needed**\n`;
    }
  }

  // Split into chunks of max 1900 chars on newlines
  const chunks = [];
  let current = '';
  for (const line of msg.split('\n')) {
    if ((current + line + '\n').length > 1900) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);

  for (const chunk of chunks) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk, username: 'Aurixlab Digest' }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} — ${body}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Digest posted successfully.');
} finally {
  client.release();
  await pool.end();
}
