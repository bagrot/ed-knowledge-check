"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { isSupabaseConfigured, supabase } from "./supabase";
import { isResultAttachment } from "./security";
import { downloadXlsx } from "./xlsx-export";

export const MOSCOW_DISTRICTS = [
  "ЦАО", "САО", "СВАО", "ВАО", "ЮВАО", "ЮАО", "ЮЗАО", "ЗАО", "СЗАО", "ЗелАО", "ТиНАО",
] as const;

type Marker = "red" | "yellow" | "green" | "pending";
type TestingKind = "first" | "repeat";
type ResultStatus = "in_work" | "checked";
type QuestionSnapshot = { id: string; categoryId: string; groupId: string; text: string; answer: string; answerVisible?: boolean };
export type DraftTestingResult = { district: string; surname: string; testingKind: TestingKind; questions: QuestionSnapshot[] };
type TestingResult = {
  id: string;
  userId: string;
  testDate: string;
  district: string;
  surname: string;
  testingKind: TestingKind;
  score: number | null;
  marker: Marker;
  filePath: string;
  fileName: string;
  fileSize: number;
  status: ResultStatus;
  questionSnapshot: QuestionSnapshot[];
  createdAt: string;
  updatedAt: string;
};
type RankingRow = { district: string; total: number; green: number; average: number; share: number };

const LOCAL_KEY = "ed-testing-results-v1";
export const RESULTS_STORAGE_KEY = LOCAL_KEY;
const markerLabels: Record<Marker, string> = { red: "Красный", yellow: "Жёлтый", green: "Зелёный", pending: "В работе" };

function markerForScore(score: number): Marker {
  if (score >= 4) return "green";
  if (score === 3) return "yellow";
  return "red";
}

function today() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function mapResult(row: Record<string, unknown>): TestingResult {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    testDate: String(row.test_date),
    district: String(row.district),
    surname: String(row.surname),
    testingKind: row.testing_kind as TestingKind,
    score: row.score == null ? null : Number(row.score),
    marker: row.result_marker ? row.result_marker as Marker : "pending",
    filePath: String(row.file_path || ""),
    fileName: String(row.file_name || ""),
    fileSize: Number(row.file_size || 0),
    status: (row.status as ResultStatus) || (row.score == null ? "in_work" : "checked"),
    questionSnapshot: Array.isArray(row.question_snapshot) ? row.question_snapshot as QuestionSnapshot[] : [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function calculateRanking(rows: TestingResult[]): RankingRow[] {
  return MOSCOW_DISTRICTS.map((district) => {
    const districtRows = rows.filter((row) => row.district === district);
    const green = districtRows.filter((row) => row.marker === "green").length;
    return {
      district,
      total: districtRows.length,
      green,
      average: districtRows.length ? districtRows.reduce((sum, row) => sum + (row.score || 0), 0) / districtRows.length : 0,
      share: districtRows.length ? green / districtRows.length : 0,
    };
  }).filter((row) => row.total > 0).sort((a, b) => b.share - a.share || b.average - a.average || b.total - a.total);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));
}

function formatBytes(value: number) {
  if (!value) return "Файл не загружен";
  return value < 1024 ? `${value} Б` : `${Math.ceil(value / 1024)} КБ`;
}

function canManage(result: TestingResult, ownerId: string, isAdmin: boolean) {
  return isAdmin || result.userId === ownerId;
}

export default function TestingResults({
  userId,
  userEmail,
  isAdmin,
  onNotice,
  incomingDraft,
  onDraftAccepted,
}: {
  userId: string;
  userEmail: string;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  incomingDraft?: DraftTestingResult | null;
  onDraftAccepted?: () => void;
}) {
  const ownerId = userId || userEmail;
  const [results, setResults] = useState<TestingResult[]>([]);
  const [ranking, setRanking] = useState<RankingRow[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TestingResult | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [districtDraft, setDistrictDraft] = useState<string>(MOSCOW_DISTRICTS[0]);
  const [surnameDraft, setSurnameDraft] = useState("");
  const [kindDraft, setKindDraft] = useState<TestingKind>("first");
  const [scoreDraft, setScoreDraft] = useState(5);
  const [search, setSearch] = useState("");
  const [districtFilter, setDistrictFilter] = useState("all");
  const [markerFilter, setMarkerFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const processingDraft = useRef<DraftTestingResult | null>(null);

  async function loadResults() {
    setLoading(true);
    if (isSupabaseConfigured && supabase && userId) {
      const [resultResponse, rankingResponse, profileResponse] = await Promise.all([
        supabase.from("test_results").select("*").is("deleted_at", null).order("test_date", { ascending: false }).order("created_at", { ascending: false }),
        supabase.rpc("get_district_ranking"),
        isAdmin ? supabase.from("profiles").select("id,email,full_name") : Promise.resolve({ data: [], error: null }),
      ]);
      if (resultResponse.error) {
        console.error("Test results load failed", resultResponse.error);
        onNotice("Не удалось загрузить результаты тестирований");
      } else {
        setResults((resultResponse.data || []).map((row) => mapResult(row as Record<string, unknown>)));
      }
      if (!rankingResponse.error) {
        setRanking((rankingResponse.data || []).map((row: Record<string, unknown>) => ({
          district: String(row.district),
          total: Number(row.total_tests),
          green: Number(row.green_count),
          average: Number(row.average_score),
          share: Number(row.green_share),
        })));
      }
      setAuthors(Object.fromEntries((profileResponse.data || []).map((row: Record<string, unknown>) => [
        String(row.id), String(row.full_name || row.email),
      ])));
      setLoading(false);
      return;
    }
    try {
      const stored = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]") as TestingResult[];
      setResults(stored);
      setRanking(calculateRanking(stored));
    } catch {
      localStorage.removeItem(LOCAL_KEY);
    }
    setLoading(false);
  }

  function saveLocal(nextVisible: TestingResult[]) {
    const all = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]") as TestingResult[];
    const visibleIds = new Set(nextVisible.map((row) => row.id));
    const nextAll = [...all.filter((row) => !visibleIds.has(row.id) || (row.userId !== ownerId && !isAdmin)), ...nextVisible];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(nextAll));
    setResults(nextAll);
    setRanking(calculateRanking(nextAll));
  }

  const visibleResults = useMemo(() => results.filter((result) =>
    result.surname.toLowerCase().includes(search.trim().toLowerCase()) &&
    (districtFilter === "all" || result.district === districtFilter) &&
    (markerFilter === "all" || result.marker === markerFilter) &&
    (kindFilter === "all" || result.testingKind === kindFilter) &&
    (!dateFrom || result.testDate >= dateFrom) &&
    (!dateTo || result.testDate <= dateTo)
  ), [results, search, districtFilter, markerFilter, kindFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(visibleResults.length / pageSize));
  const paginatedResults = visibleResults.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageItems = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1) as (number | "ellipsis")[];
    const pages = [...new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])]
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((a, b) => a - b);
    const items: (number | "ellipsis")[] = [];
    pages.forEach((page, index) => {
      if (index > 0 && page - pages[index - 1] > 1) items.push("ellipsis");
      items.push(page);
    });
    return items;
  }, [currentPage, totalPages]);

  const filterKey = JSON.stringify([search, districtFilter, markerFilter, kindFilter, dateFrom, dateTo, pageSize]);
  const [previousFilter, setPreviousFilter] = useState(filterKey);
  if (filterKey !== previousFilter) {
    setPreviousFilter(filterKey); setCurrentPage(1); setExpanded(null);
  } else if (currentPage > totalPages) { setCurrentPage(totalPages); }

  function goToPage(page: number) {
    setCurrentPage(Math.min(Math.max(page, 1), totalPages));
    setExpanded(null);
  }

  const surnameOptions = useMemo(() => [...new Set(results
    .filter((row) => row.district === districtDraft && row.status === "checked")
    .map((row) => row.surname))].sort((a, b) => a.localeCompare(b, "ru")), [results, districtDraft]);

  function inferKind(surname: string, district: string) {
    if (editing) return;
    const normalized = surname.trim().toLowerCase();
    setKindDraft(results.some((row) => row.district === district && row.surname.trim().toLowerCase() === normalized) ? "repeat" : "first");
  }

  function openEditor(result: TestingResult | null) {
    setEditing(result);
    setDistrictDraft(result?.district || MOSCOW_DISTRICTS[0]);
    setSurnameDraft(result?.surname || "");
    setKindDraft(result?.testingKind || "first");
    setScoreDraft(result?.score ?? 5);
    setModalOpen(true);
  }

  async function createInWorkResult(draft: DraftTestingResult) {
    const now = new Date().toISOString();
    const next: TestingResult = {
      id: crypto.randomUUID(),
      userId: ownerId,
      testDate: today(),
      district: draft.district,
      surname: draft.surname.trim(),
      testingKind: draft.testingKind,
      score: null,
      marker: "pending",
      filePath: "",
      fileName: "",
      fileSize: 0,
      status: "in_work",
      questionSnapshot: draft.questions.map((q) => ({ ...q, answerVisible: false })),
      createdAt: now,
      updatedAt: now,
    };
    if (!next.surname) {
      onNotice("Укажите фамилию перед передачей вопросов в работу");
      return;
    }
    if (isSupabaseConfigured && supabase && userId) {
      const { error } = await supabase.from("test_results").insert({
        id: next.id, user_id: next.userId, test_date: next.testDate, district: next.district, surname: next.surname,
        testing_kind: next.testingKind, score: null, file_path: null, file_name: null, file_size: null, status: next.status,
        question_snapshot: next.questionSnapshot, updated_at: next.updatedAt,
      });
      if (error) {
        console.error("Create in-work result failed", error);
        processingDraft.current = null;
        const databaseNeedsUpdate = error.code === "PGRST204" || error.code === "42703" || /status|question_snapshot|schema cache/i.test(error.message);
        onNotice(databaseNeedsUpdate ? "Нужно обновить структуру базы данных" : `Не удалось передать вопросы: ${error.message}`);
        return;
      }
      await loadResults();
    } else {
      const all = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]") as TestingResult[];
      const nextAll = [next, ...all];
      localStorage.setItem(LOCAL_KEY, JSON.stringify(nextAll));
      setResults(nextAll);
      setRanking(calculateRanking(nextAll));
    }
    onDraftAccepted?.();
    onNotice("Вопросы переданы в работу");
  }

  async function saveResult(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file") as File;
    const surname = surnameDraft.trim();
    const testDate = String(form.get("testDate") || "");
    if (!surname || !testDate) return;
    if ((!editing || editing.status === "in_work") && (!file || !file.size)) {
      onNotice("Прикрепите файл с ответами");
      return;
    }
    if (file?.size) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!extension || !["doc", "docx"].includes(extension)) {
        onNotice("Можно прикрепить только файл DOC или DOCX");
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        onNotice("Размер файла не должен превышать 2 МБ");
        return;
      }
    }

    const id = editing?.id || crypto.randomUUID();
    let filePath = editing?.filePath || "";
    let fileName = editing?.fileName || "";
    let fileSize = editing?.fileSize || 0;
    let uploadedPath = "";
    if (isSupabaseConfigured && supabase && userId && file?.size) {
      const extension = file.name.split(".").pop()?.toLowerCase() || "docx";
      uploadedPath = `${editing?.userId || userId}/${id}/${Date.now()}.${extension}`;
      const { error } = await supabase.storage.from("test-answers").upload(uploadedPath, file, { upsert: false });
      if (error) {
        console.error("Test result file upload failed", error);
        onNotice(`Не удалось загрузить файл: ${error.message}`);
        return;
      }
      filePath = uploadedPath;
      fileName = file.name;
      fileSize = file.size;
    } else if (file?.size) {
      filePath = `local://${file.name}`;
      fileName = file.name;
      fileSize = file.size;
    }

    const now = new Date().toISOString();
    const next: TestingResult = {
      id,
      userId: editing?.userId || ownerId,
      testDate,
      district: districtDraft,
      surname,
      testingKind: kindDraft,
      score: scoreDraft,
      marker: markerForScore(scoreDraft),
      filePath,
      fileName,
      fileSize,
      status: "checked",
      questionSnapshot: editing?.questionSnapshot || [],
      createdAt: editing?.createdAt || now,
      updatedAt: now,
    };

    if (isSupabaseConfigured && supabase && userId) {
      const payload = {
        id: next.id,
        user_id: next.userId,
        test_date: next.testDate,
        district: next.district,
        surname: next.surname,
        testing_kind: next.testingKind,
        score: next.score,
        file_path: next.filePath,
        file_name: next.fileName,
        file_size: next.fileSize,
        status: next.status,
        question_snapshot: next.questionSnapshot,
        updated_at: next.updatedAt,
      };
      const response = editing
        ? await supabase.from("test_results").update(payload).eq("id", next.id)
        : await supabase.from("test_results").insert(payload);
      if (response.error) {
        if (uploadedPath) await supabase.storage.from("test-answers").remove([uploadedPath]);
        onNotice("Не удалось сохранить результат");
        return;
      }
      if (editing && uploadedPath && editing.filePath && isResultAttachment(editing.filePath, editing.userId, editing.id)) {
        await supabase.storage.from("test-answers").remove([editing.filePath]);
      }
      await loadResults();
    } else {
      const nextRows = editing ? results.map((row) => row.id === next.id ? next : row) : [next, ...results];
      saveLocal(nextRows);
    }
    setModalOpen(false);
    setEditing(null);
    onNotice(editing ? "Результат обновлён" : "Результат добавлен");
  }

  async function removeResult(result: TestingResult) {
    if (!confirm(`Скрыть тестирование «${result.surname}»? Запись будет сохранена в архиве администратора.`)) return;
    if (isSupabaseConfigured && supabase && userId) {
      const { error } = await supabase.rpc("archive_result", { target_result: result.id });
      if (error) {
        onNotice("Не удалось удалить результат");
        return;
      }
      await loadResults();
    } else {
      saveLocal(results.filter((row) => row.id !== result.id));
    }
    onNotice("Результат удалён");
  }

  async function downloadAttachment(result: TestingResult) {
    if (!isSupabaseConfigured || !supabase || !userId) {
      onNotice("В деморежиме содержимое файла не сохраняется");
      return;
    }
    const { data, error } = await supabase.storage.from("test-answers").download(result.filePath);
    if (error || !data) {
      onNotice("Не удалось скачать файл");
      return;
    }
    const url = URL.createObjectURL(data);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function exportExcel(rows: TestingResult[], filtered: boolean) {
    if (!rows.length) {
      onNotice("Нет результатов для выгрузки");
      return;
    }
    const headers = ["№", "Дата тестирования", "Округ", "Фамилия", "Тестирование", "Баллы", "Маркер", "Файл", "Добавил"];
    const report = rows.map((row, index) => [
      index + 1,
      formatDate(row.testDate),
      row.district,
      row.surname,
      row.testingKind === "repeat" ? "Повторное" : "Первое",
      row.score ?? "",
      markerLabels[row.marker],
      row.fileName,
      authors[row.userId] || (row.userId === ownerId ? userEmail : row.userId),
    ]);
    downloadXlsx(`Результаты тестирований${filtered ? " — по фильтрам" : ""}.xlsx`, headers, report, [5, 18, 11, 24, 16, 9, 12, 30, 28]);
    onNotice("Excel-отчёт скачан");
  }

  const checkedResults = results.filter((result) => result.status === "checked");
  const analyticsRows = districtFilter === "all" ? checkedResults : checkedResults.filter((row) => row.district === districtFilter);
  const displayedRanking = districtFilter === "all" && ranking.length ? ranking : calculateRanking(analyticsRows);
  const analyticsTotal = analyticsRows.length;
  const analyticsAverage = analyticsTotal ? analyticsRows.reduce((sum, row) => sum + (row.score || 0), 0) / analyticsTotal : 0;
  const analyticsGreen = analyticsRows.filter((row) => row.marker === "green").length;
  const markerCounts = {
    green: analyticsRows.filter((row) => row.marker === "green").length,
    yellow: analyticsRows.filter((row) => row.marker === "yellow").length,
    red: analyticsRows.filter((row) => row.marker === "red").length,
  };
  const markerPercent = (marker: "green" | "yellow" | "red") => analyticsTotal ? Math.round(markerCounts[marker] / analyticsTotal * 100) : 0;
  const scoreDistribution = [0, 1, 2, 3, 4, 5].map((score) => ({ score, count: analyticsRows.filter((row) => row.score === score).length }));
  const scorePeak = Math.max(1, ...scoreDistribution.map((item) => item.count));
  const monthlyTrend = Object.entries(analyticsRows.reduce<Record<string, { total: number; count: number }>>((months, row) => {
    const month = row.testDate.slice(0, 7);
    const current = months[month] || { total: 0, count: 0 };
    months[month] = { total: current.total + (row.score || 0), count: current.count + 1 };
    return months;
  }, {})).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([month, value]) => ({
    month,
    label: new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit" }).format(new Date(`${month}-01T00:00:00`)),
    average: value.total / value.count,
  }));

  const refreshResults = useEffectEvent(loadResults);
  const acceptDraft = useEffectEvent(createInWorkResult);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshResults(), 0);
    return () => window.clearTimeout(timer);
  }, [ownerId, isAdmin]);
  useEffect(() => {
    if (!incomingDraft || processingDraft.current === incomingDraft) return;
    processingDraft.current = incomingDraft;
    void acceptDraft(incomingDraft);
  }, [incomingDraft]);

  return <div className="page results-page">
    <div className="page-heading results-heading">
      <div><p className="eyebrow">КОНТРОЛЬ РЕЗУЛЬТАТОВ</p><h1>Проведённые тестирования</h1><p>Фиксируйте проверки, ответы и динамику результатов по округам.</p></div>
      <div className="heading-actions">
        {isAdmin && <button className="secondary" onClick={() => void exportExcel(results, false)}>Выгрузить всё</button>}
        <button className="primary" onClick={() => openEditor(null)}>+ Добавить результат</button>
      </div>
    </div>

    <div className="results-tabs"><button className={!analyticsOpen ? "active" : ""} onClick={() => setAnalyticsOpen(false)}>Список</button><button className={analyticsOpen ? "active" : ""} onClick={() => setAnalyticsOpen(true)}>Аналитика по округам</button></div>

    {analyticsOpen && <section className="analytics-panel">
      <div className="analytics-summary"><article><span>Проверено</span><b>{analyticsTotal}</b></article><article><span>Средний балл</span><b>{analyticsAverage.toFixed(1)}</b></article><article><span>Зелёные</span><b>{analyticsGreen}</b></article></div>
      <div className="analytics-charts">
        <article className="chart-card marker-chart">
          <div className="chart-heading"><div><span>Результаты</span><h3>Распределение маркеров</h3></div><b>{analyticsTotal}</b></div>
          <div className="donut-wrap">
            <div className="donut" style={{ "--green": `${markerPercent("green") * 3.6}deg`, "--yellow": `${(markerPercent("green") + markerPercent("yellow")) * 3.6}deg` } as React.CSSProperties}><span>{markerPercent("green")}%<small>зелёных</small></span></div>
            <div className="chart-legend"><span><i className="green" />Зелёные <b>{markerCounts.green}</b></span><span><i className="yellow" />Жёлтые <b>{markerCounts.yellow}</b></span><span><i className="red" />Красные <b>{markerCounts.red}</b></span></div>
          </div>
        </article>
        <article className="chart-card score-chart">
          <div className="chart-heading"><div><span>Оценки</span><h3>Распределение баллов</h3></div></div>
          <div className="score-columns">{scoreDistribution.map((item) => <div key={item.score}><b>{item.count}</b><span><i style={{ height: `${Math.max(item.count ? 8 : 0, item.count / scorePeak * 100)}%` }} /></span><small>{item.score}</small></div>)}</div>
        </article>
        <article className="chart-card trend-chart">
          <div className="chart-heading"><div><span>Динамика</span><h3>Средний балл по месяцам</h3></div></div>
          {monthlyTrend.length ? <div className="trend-bars">{monthlyTrend.map((item) => <div key={item.month}><span>{item.label}</span><i><b style={{ width: `${item.average / 5 * 100}%` }} /></i><strong>{item.average.toFixed(1)}</strong></div>)}</div> : <p className="chart-empty">Пока недостаточно данных</p>}
        </article>
      </div>
      <div className="analytics-bars">{displayedRanking.map((row) => <article key={row.district}><div><b>{row.district}</b><span>{row.total} проверок</span></div><div className="bar"><i style={{ width: `${Math.round(row.share * 100)}%` }} /></div><strong>{Math.round(row.share * 100)}%</strong></article>)}</div>
    </section>}

    {analyticsOpen && <section className="ranking-card">
      <div className="ranking-title"><div><p className="eyebrow">РЕЙТИНГ ОКРУГОВ</p><h2>По доле зелёных результатов</h2></div><span>При равенстве учитывается средний балл</span></div>
      {displayedRanking.length ? <div className="ranking-list">{displayedRanking.map((row, index) => <article key={row.district}>
        <b className="ranking-place">{index + 1}</b><div><strong>{row.district}</strong><small>{row.green} зелёных из {row.total}</small></div>
        <span>{Math.round(row.share * 100)}%</span><em>{row.average.toFixed(1)} / 5</em>
      </article>)}</div> : <p className="ranking-empty">Рейтинг появится после добавления первых результатов.</p>}
    </section>}

    <div className="results-filters">
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по фамилии" />
      <select value={districtFilter} onChange={(event) => setDistrictFilter(event.target.value)}><option value="all">Все округа</option>{MOSCOW_DISTRICTS.map((district) => <option key={district}>{district}</option>)}</select>
      <select value={markerFilter} onChange={(event) => setMarkerFilter(event.target.value)}><option value="all">Все маркеры</option><option value="green">Зелёный</option><option value="yellow">Жёлтый</option><option value="red">Красный</option></select>
      <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="all">Все тестирования</option><option value="first">Первое</option><option value="repeat">Повторное</option></select>
      <label>С<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
      <label>По<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      {isAdmin && <button className="ghost" onClick={() => void exportExcel(visibleResults, true)}>Excel по фильтрам</button>}
    </div>

    <section className="results-table">
      <div className="results-table-head"><span>Дата</span><span>Округ</span><span>Фамилия</span><span>Проверка</span><span>Баллы</span><span>Результат</span><span /></div>
      {loading ? <div className="results-message">Загружаем результаты…</div> : visibleResults.length ? paginatedResults.map((result) => <div className="result-record" key={result.id}>
        <button className="result-row" onClick={() => setExpanded(expanded === result.id ? null : result.id)} aria-expanded={expanded === result.id}>
          <span>{formatDate(result.testDate)}</span><span>{result.district}</span><strong>{result.surname}</strong><span>{result.testingKind === "repeat" ? "Повторное" : "Первое"}</span><b>{result.score == null ? "-" : `${result.score} / 5`}</b><i className={`marker ${result.marker}`}>{markerLabels[result.marker]}</i><em>{expanded === result.id ? "−" : "+"}</em>
        </button>
        {expanded === result.id && <div className="result-details">
          <div><small>Прикреплённый файл</small><b>{result.fileName || "Файл не загружен"}</b><span>{formatBytes(result.fileSize)}</span></div>
          {result.questionSnapshot.length > 0 && <div className="snapshot-list"><small>Вопросы</small>{result.questionSnapshot.map((question, index) => <details key={`${result.id}-${question.id}-${index}`}><summary>{index + 1}. {question.text}</summary><p>{question.answer}</p></details>)}</div>}
          {isAdmin && <div><small>Добавил</small><b>{authors[result.userId] || (result.userId === ownerId ? userEmail : "Пользователь")}</b><span>{new Date(result.createdAt).toLocaleString("ru-RU")}</span></div>}
          <div className="result-actions">{result.filePath && <button className="secondary" onClick={() => void downloadAttachment(result)}>Скачать файл</button>}{canManage(result, ownerId, isAdmin) && <button className="ghost" onClick={() => openEditor(result)}>{result.status === "in_work" ? "Загрузить результат" : "Редактировать"}</button>}{canManage(result, ownerId, isAdmin) && <button className="danger-button" onClick={() => void removeResult(result)}>Удалить</button>}</div>
        </div>}
      </div>) : <div className="results-message">По заданным условиям результатов нет.</div>}
    </section>

    {!loading && visibleResults.length > 0 && <div className="results-pagination">
      <label>Показывать<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
      <span>{(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, visibleResults.length)} из {visibleResults.length}</span>
      <nav aria-label="Страницы результатов">
        <button type="button" aria-label="Предыдущая страница" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>‹</button>
        {pageItems.map((item, index) => item === "ellipsis" ? <i key={`ellipsis-${index}`}>…</i> : <button type="button" key={item} className={currentPage === item ? "active" : ""} aria-current={currentPage === item ? "page" : undefined} onClick={() => goToPage(item)}>{item}</button>)}
        <button type="button" aria-label="Следующая страница" disabled={currentPage === totalPages} onClick={() => goToPage(currentPage + 1)}>›</button>
      </nav>
    </div>}

    {modalOpen && <div className="modal-backdrop" onMouseDown={() => setModalOpen(false)}><form className="modal result-modal" onSubmit={saveResult} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><p className="eyebrow">РЕЗУЛЬТАТ ПРОВЕРКИ</p><h2>{editing ? "Редактирование" : "Новое тестирование"}</h2></div><button type="button" onClick={() => setModalOpen(false)}>×</button></div>
      <div className="result-form-grid">
        <label>Дата проведения<input name="testDate" type="date" required defaultValue={editing?.testDate || today()} /></label>
        <label>Округ<select value={districtDraft} onChange={(event) => { setDistrictDraft(event.target.value); inferKind(surnameDraft, event.target.value); }}>{MOSCOW_DISTRICTS.map((district) => <option key={district}>{district}</option>)}</select></label>
      </div>
      <label>Фамилия<input list="district-surnames" required value={surnameDraft} onChange={(event) => { setSurnameDraft(event.target.value); inferKind(event.target.value, districtDraft); }} placeholder="Введите или выберите фамилию" /><datalist id="district-surnames">{surnameOptions.map((surname) => <option value={surname} key={surname} />)}</datalist></label>
      <div className="result-form-grid align-end">
        <label className="toggle-label result-kind"><input type="checkbox" checked={kindDraft === "repeat"} onChange={(event) => setKindDraft(event.target.checked ? "repeat" : "first")} /><span /> {kindDraft === "repeat" ? "Повторное тестирование" : "Первое тестирование"}</label>
        <label>Количество баллов<select value={scoreDraft} onChange={(event) => setScoreDraft(Number(event.target.value))}>{[0, 1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score} из 5</option>)}</select></label>
      </div>
      <div className={`result-preview ${markerForScore(scoreDraft)}`}><i /><span>Маркер будет установлен автоматически:</span><b>{markerLabels[markerForScore(scoreDraft)]}</b></div>
      <label>Файл с ответами ({editing && editing.status === "checked" ? "оставьте пустым, чтобы сохранить текущий" : "обязательно"})<input name="file" type="file" required={!editing || editing.status === "in_work"} accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /><small className="field-hint">DOC или DOCX, не более 2 МБ</small></label>
      <div className="modal-actions"><button type="button" className="ghost" onClick={() => setModalOpen(false)}>Отмена</button><button className="primary" type="submit">Сохранить</button></div>
    </form></div>}
  </div>;
}
