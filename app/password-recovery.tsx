"use client";

import { useState } from "react";
import { supabase } from "./supabase";

export default function PasswordRecovery({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (password.length < 12) return setError("Используйте не менее 12 символов.");
    if (password !== form.get("confirmation")) return setError("Пароли не совпадают.");
    setBusy(true);
    setError("");
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      await supabase.auth.signOut();
      window.history.replaceState(null, "", "/");
      onDone();
    } catch {
      setError("Не удалось изменить пароль. Запросите новую ссылку восстановления и попробуйте ещё раз.");
    } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-form-wrap"><form className="auth-card" onSubmit={submit}>
    <h1>Новый пароль</h1><p>После сохранения войдите с новым паролем.</p>
    <label>Пароль<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
    <label>Повторите пароль<input name="confirmation" type="password" minLength={12} required autoComplete="new-password" /></label>
    {error && <p role="alert" className="auth-error">{error}</p>}
    <button className="primary full" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить пароль"}</button>
  </form></section></main>;
}
