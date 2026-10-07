import { createClient } from "npm:@supabase/supabase-js@2.111.0";

type StoredResult = { id: string; user_id: string; file_path: string | null; updated_at: string };

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function moscowCalendar(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextQuarter(year: number, month: number) {
  const nextMonth = (Math.floor(month / 3) + 1) * 3;
  return nextMonth >= 12 ? { year: year + 1, month: 0 } : { year, month: nextMonth };
}

Deno.serve(async (request) => {
  const cronSecret = Deno.env.get("RETENTION_CRON_SECRET");
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const projectUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RETENTION_FROM_EMAIL");
  if (!projectUrl || !serviceKey || !resendKey || !fromEmail) {
    return json({ error: "Required secrets are not configured" }, 500);
  }

  const client = createClient(projectUrl, serviceKey, { auth: { persistSession: false } });
  const { year, month, day } = moscowCalendar();
  const isQuarterStartWindow = month % 3 === 0 && day <= 3;

  if (isQuarterStartWindow) {
    const cutoff = isoDate(year, month, 1);
    const rows: StoredResult[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client.from("test_results").select("id,user_id,file_path,updated_at").lt("test_date", cutoff).order("id").range(from, from + 999);
      if (error) return json({ error: error.message }, 500);
      rows.push(...((data || []) as StoredResult[]));
      if (!data || data.length < 1000) break;
    }

    let deleted = 0;
    for (const row of rows) {
      const prefix = `${row.user_id}/${row.id}/`;
      if (row.file_path && (!row.file_path.startsWith(prefix) || !/^\d+\.docx?$/.test(row.file_path.slice(prefix.length)))) {
        return json({ error: "Unsafe attachment path; cleanup stopped" }, 409);
      }
      if (row.file_path) {
        const { error } = await client.storage.from("test-answers").remove([row.file_path]);
        if (error) return json({ error: `Storage cleanup failed: ${error.message}` }, 500);
      }
      const { data, error } = await client.from("test_results").delete().eq("id", row.id).eq("updated_at", row.updated_at).select("id");
      if (error) return json({ error: "Database cleanup failed" }, 500);
      deleted += data?.length || 0;
    }
    return json({ action: "cleanup", cutoff, deleted });
  }

  const next = nextQuarter(year, month);
  const deletionDate = isoDate(next.year, next.month, 1);
  const todayUtc = Date.UTC(year, month, day);
  const deletionUtc = Date.UTC(next.year, next.month, 1);
  const daysBefore = Math.round((deletionUtc - todayUtc) / 86_400_000);
  if (![14, 3, 2, 1].includes(daysBefore)) return json({ action: "none", daysBefore });

  const { data: previous } = await client.from("retention_notifications")
    .select("deletion_date").eq("deletion_date", deletionDate).eq("days_before", daysBefore).maybeSingle();
  if (previous) return json({ action: "already-sent", deletionDate, daysBefore });

  const { data: admins, error: adminError } = await client.from("profiles")
    .select("email").eq("role", "admin").eq("is_blocked", false);
  if (adminError) return json({ error: adminError.message }, 500);
  const recipients = [...new Set((admins || []).map((admin) => admin.email).filter(Boolean))];
  if (!recipients.length) return json({ error: "No active administrator emails" }, 500);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: fromEmail,
      to: recipients,
      subject: `Удаление результатов тестирований через ${daysBefore} дн.`,
      html: `<p>Здравствуйте!</p><p><strong>${deletionDate}</strong> в 09:00 по московскому времени будут безвозвратно удалены результаты завершившегося квартала и все приложенные к ним файлы.</p><p>При необходимости выгрузите Excel-отчёт и скачайте нужные файлы заранее.</p>`,
    }),
  });
  if (!response.ok) return json({ error: `Email sending failed: ${await response.text()}` }, 502);

  const { error: logError } = await client.from("retention_notifications").insert({
    deletion_date: deletionDate,
    days_before: daysBefore,
  });
  if (logError) return json({ error: logError.message }, 500);
  return json({ action: "notification", deletionDate, daysBefore, recipients: recipients.length });
});
