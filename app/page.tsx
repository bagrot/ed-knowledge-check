"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import PasswordRecovery from "./password-recovery";
import { randomIndex, shuffled } from "./security";
import { isSupabaseConfigured, supabase } from "./supabase";
import TestingResults, { DraftTestingResult, MOSCOW_DISTRICTS } from "./testing-results";

type Category = { id: string; name: string; color: string };
type QuestionGroup = { id: string; categoryId: string; name: string };
type Question = {
  id: string;
  categoryId: string;
  groupId: string;
  text: string;
  answer: string;
  active: boolean;
};
type User = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "blocked";
  deactivated?: boolean;
};
type TestItem = Question & { answerVisible?: boolean };
type View = "generator" | "results" | "questions" | "categories" | "users";

const initialCategories: Category[] = [];
const initialGroups: QuestionGroup[] = [];
const initialQuestions: Question[] = [];
const initialUsers: User[] = [];
const VIEW_STORAGE_KEY = "ed-knowledge-check-view";
const ALL_VIEWS: View[] = ["generator", "results", "questions", "categories", "users"];

function Icon({ name }: { name: "home" | "results" | "questions" | "categories" | "users" | "logout" | "eye" | "download" | "shuffle" | "plus" | "edit" | "trash" | "menu" | "close" }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5M9 20v-6h6v6"/></>,
    results: <><path d="M9 4h6M9 2h6v4H9z"/><rect x="5" y="4" width="14" height="18" rx="2"/><path d="M8 11h8M8 15h5"/></>,
    questions: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
    categories: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 19v2h16v-2"/></>,
    shuffle: <><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function withTimeout<T>(request: PromiseLike<T>, timeoutMs = 7000): Promise<T> {
  return Promise.race([
    Promise.resolve(request),
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error("SERVICE_TIMEOUT")), timeoutMs)),
  ]);
}

function serviceErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/failed to fetch|network|service_timeout|name_not_resolved|load failed/i.test(message)) {
    return "Сервис авторизации временно недоступен. Попробуйте ещё раз через несколько минут.";
  }
  if (/invalid login credentials/i.test(message)) return "Неверная электронная почта или пароль";
  if (/email not confirmed/i.test(message)) return "Подтвердите электронную почту перед входом";
  return message || "Не удалось выполнить операцию";
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [sessionEmail, setSessionEmail] = useState("");
  const [sessionUserId, setSessionUserId] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "reset">("login");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [view, setView] = useState<View>("generator");
  const [viewRestored, setViewRestored] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [groups, setGroups] = useState<QuestionGroup[]>(initialGroups);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [databaseQuestionCount, setDatabaseQuestionCount] = useState(initialQuestions.length);
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [test, setTest] = useState<TestItem[]>([]);
  const [selected, setSelected] = useState<string[]>(["agenda"]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>(["intercom", "capital", "management", "postamat", "barrier"]);
  const [themeCounts, setThemeCounts] = useState<Record<string, number>>({
    intercom: 2,
    capital: 2,
    management: 2,
    postamat: 2,
    barrier: 2,
  });
  const [notice, setNotice] = useState("");
  const [questionSearch, setQuestionSearch] = useState("");
  const [questionCategory, setQuestionCategory] = useState("all");
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [questionModal, setQuestionModal] = useState(false);
  const [questionTopGroupId, setQuestionTopGroupId] = useState("agenda");
  const [questionThemeId, setQuestionThemeId] = useState("intercom");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [groupDraft, setGroupDraft] = useState("");
  const [groupCategoryDraft, setGroupCategoryDraft] = useState("agenda");
  const [taxonomyEdit, setTaxonomyEdit] = useState<{ type: "category" | "group"; id: string; name: string; categoryId?: string } | null>(null);
  const [workDistrict, setWorkDistrict] = useState<string>(MOSCOW_DISTRICTS[0]);
  const [workSurname, setWorkSurname] = useState("");
  const [workKind, setWorkKind] = useState<"first" | "repeat">("first");
  const [pendingDraft, setPendingDraft] = useState<DraftTestingResult | null>(null);

  async function loadSupabaseData(userId: string, email: string, showLoading = true) {
    if (!supabase) return;
    if (showLoading) setReady(false);
    try {
      const { data: profile, error: profileError } = await withTimeout(supabase
        .from("profiles")
        .select("id,email,full_name,role,is_blocked,deactivated_at")
        .eq("id", userId)
        .single());
      if (profileError) throw profileError;
      if (profile.is_blocked || profile.deactivated_at) {
        await supabase.auth.signOut();
        setAuthError("Доступ не предоставлен. Обратитесь к администратору.");
        return;
      }

      const [{ data: categoryRows, error: categoriesError }, { data: groupRows, error: groupsError }, { data: questionRows, error: questionsError }] = await withTimeout(Promise.all([
        supabase.from("categories").select("id,name,color").order("created_at"),
        supabase.from("question_groups").select("id,category_id,name").order("created_at"),
        supabase.from("questions").select("id,category_id,group_id,question_text,answer_text,is_active").order("created_at"),
      ]));
      if (categoriesError || groupsError || questionsError) throw categoriesError || groupsError || questionsError;

      const nextCategories: Category[] = (categoryRows || []).map((row) => ({ id: row.id, name: row.name, color: row.color }));
      const nextGroups: QuestionGroup[] = (groupRows || []).map((row) => ({ id: row.id, categoryId: row.category_id, name: row.name }));
      const nextQuestions: Question[] = (questionRows || []).map((row) => ({
        id: row.id,
        categoryId: row.category_id,
        groupId: row.group_id,
        text: row.question_text,
        answer: row.answer_text,
        active: row.is_active,
      }));

      const { data: currentTest } = await withTimeout(supabase
        .from("current_tests")
        .select("question_ids")
        .eq("user_id", userId)
        .maybeSingle());
      const questionById = new Map(nextQuestions.map((question) => [question.id, question]));
      setTest((currentTest?.question_ids || []).flatMap((id: string) => {
        const question = questionById.get(id);
        return question ? [{ ...question, answerVisible: false }] : [];
      }));

      let profileRows = [profile];
      if (profile.role === "admin") {
        const { data } = await withTimeout(supabase.from("profiles").select("id,email,full_name,role,is_blocked,deactivated_at").order("created_at"));
        profileRows = data || profileRows;
      }
      setUsers(profileRows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.full_name || row.email.split("@")[0],
        role: row.role,
        status: row.is_blocked ? "blocked" : "active",
        deactivated: Boolean(row.deactivated_at),
      })));
      setAuthError("");
      setCategories(nextCategories);
      setGroups(nextGroups);
      setQuestions(nextQuestions);
      setSessionUserId(userId);
      setSessionEmail(email);
      const storedView = localStorage.getItem(VIEW_STORAGE_KEY) as View | null;
      setView(storedView && ALL_VIEWS.includes(storedView) && (profile.role === "admin" || storedView === "generator" || storedView === "results") ? storedView : "generator");
      setViewRestored(true);

      const initiallySelected = nextCategories.filter((category) =>
        nextQuestions.some((question) => question.categoryId === category.id && question.active)
      );
      if (initiallySelected.length) setSelected((previous) => previous.length ? previous : [initiallySelected[0].id]);
    } catch (error) {
      console.error("Supabase load failed", error);
      setAuthError(serviceErrorMessage(error));
    } finally {
      setReady(true);
    }
  }

  const onLoadSession = useEffectEvent(loadSupabaseData);

  useEffect(() => {
    if (isSupabaseConfigured && supabase) {
      let mounted = true;
      void withTimeout(supabase.rpc("get_public_question_count"), 4000).then(({ data }) => {
        if (mounted && typeof data === "number") setDatabaseQuestionCount(data);
      }).catch(() => undefined);
      void (async () => {
        try {
          const { data } = await withTimeout(supabase.auth.getSession(), 5000);
          if (!mounted) return;
          if (new URLSearchParams(window.location.search).get("recovery") === "1" && data.session) {
            setRecovering(true); setReady(true); return;
          }
          if (data.session?.user) {
            await onLoadSession(data.session.user.id, data.session.user.email || "");
          } else {
            setReady(true);
          }
        } catch (error) {
          if (!mounted) return;
          console.error("Session restore failed", error);
          setAuthError(serviceErrorMessage(error));
          setReady(true);
        }
      })();
      const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
        window.setTimeout(() => {
          if (!mounted) return;
          if (event === "PASSWORD_RECOVERY") { setRecovering(true); setReady(true); return; }
          if (event === "SIGNED_OUT" || !session?.user) {
            setUsers([]); setQuestions([]); setCategories([]); setGroups([]); setTest([]);
            setSessionEmail("");
            setSessionUserId("");
            setView("generator");
            setViewRestored(false);
            setReady(true);
          } else if (event === "SIGNED_IN" || event === "USER_UPDATED") {
            void onLoadSession(session.user.id, session.user.email || "", false);
          }
        }, 0);
      });
      return () => {
        mounted = false;
        listener.subscription.unsubscribe();
      };
    }
    setTimeout(() => { setAuthError("Сервис не настроен. Обратитесь к администратору."); setReady(true); }, 0);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const surname = workSurname.trim().toLowerCase();
    if (!surname) return;
    if (isSupabaseConfigured && supabase && sessionUserId) {
      const client = supabase;
      let cancelled = false;
      const timer = window.setTimeout(async () => {
        const { data } = await client
          .from("test_results")
          .select("id")
          .eq("district", workDistrict)
          .ilike("surname", workSurname.trim())
          .is("deleted_at", null)
          .limit(1);
        if (!cancelled) setWorkKind(data?.length ? "repeat" : "first");
      }, 250);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
  }, [workDistrict, workSurname, sessionUserId]);

  const currentUser = users.find((user) => user.email === sessionEmail);
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    if (!viewRestored || !currentUser) return;
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view, viewRestored, currentUser]);

  const activeCounts = useMemo(() => Object.fromEntries(categories.map((category) => [
    category.id,
    questions.filter((question) => question.categoryId === category.id && question.active).length,
  ])), [categories, questions]);
  const questionCount = selectedGroups.reduce((sum, themeId) => sum + (themeCounts[themeId] || 0), 0);

  async function persistCurrentTest(nextTest: TestItem[]) {
    if (!supabase || !sessionUserId) return;
    const { error } = await supabase.from("current_tests").upsert({
      user_id: sessionUserId,
      question_ids: nextTest.map((question) => question.id),
      generated_at: new Date().toISOString(),
    });
    if (error) console.error("Current test save failed", error);
  }

  async function authSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const name = String(form.get("name") || "").trim();

    if (isSupabaseConfigured && supabase) {
      if (authSubmitting) return;
      setAuthSubmitting(true);
      try {
        if (authMode === "reset") {
          const { error } = await withTimeout(supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/?recovery=1`,
          }));
          if (error) throw error;
          setNotice(`Инструкция отправлена на ${email}`);
          setAuthMode("login");
          return;
        }
        if (authMode === "register" && password.length < 12) {
          setAuthError("Пароль должен содержать не менее 12 символов");
          return;
        }
        if (authMode === "register") {
          const { data, error } = await withTimeout(supabase.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/`,
              data: { full_name: name },
            },
          }));
          if (error) throw error;
          if (!data.session) {
            setNotice("Подтвердите почту и обратитесь к администратору для предоставления доступа");
            setAuthMode("login");
          }
          return;
        }
        const { error } = await withTimeout(supabase.auth.signInWithPassword({ email, password }));
        if (error) throw error;
        setAuthError("");
        return;
      } catch (error) {
        setAuthError(serviceErrorMessage(error));
        return;
      } finally {
        setAuthSubmitting(false);
      }
    }

    setAuthError("Сервис авторизации не настроен.");
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setSessionEmail("");
    setSessionUserId("");
  }

  function generateTest() {
    const eligibleThemes = selectedGroups.filter((themeId) => (themeCounts[themeId] || 0) > 0);
    if (!eligibleThemes.length) {
      setNotice("Выберите хотя бы одну тематику и укажите количество вопросов");
      return;
    }
    const generated: TestItem[] = [];
    eligibleThemes.forEach((themeId) => {
      const pool = shuffled(questions
        .filter((question) =>
          question.groupId === themeId &&
          question.active &&
          selected.includes(question.categoryId)
        )
        );
      const needed = themeCounts[themeId] || 0;
      generated.push(...pool.slice(0, needed).map((item) => ({ ...item, answerVisible: false })));
    });
    const nextTest = shuffled(generated);
    setTest(nextTest);
    void persistCurrentTest(nextTest);
    if (generated.length < questionCount) {
      setNotice(`Сформировано ${generated.length} из ${questionCount}: в выбранных тематиках пока недостаточно вопросов`);
    } else {
      setNotice("Новый перечень вопросов сформирован");
    }
  }

  function replaceQuestion(index: number) {
    const current = test[index];
    const used = new Set(test.map((question) => question.id));
    const candidates = questions.filter((question) =>
      question.active &&
      question.groupId === current.groupId &&
      !used.has(question.id)
    );
    if (!candidates.length) {
      setNotice("В выбранных группах и тематиках нет другого свободного вопроса");
      return;
    }
    const replacement = candidates[randomIndex(candidates.length)];
    const nextTest = test.map((item, itemIndex) => itemIndex === index ? { ...replacement, answerVisible: false } : item);
    setTest(nextTest);
    void persistCurrentTest(nextTest);
  }

  function takeGeneratedTestToWork() {
    const surname = workSurname.trim();
    if (!test.length) {
      setNotice("Сначала сформируйте вопросы");
      return;
    }
    if (!surname) {
      setNotice("Укажите фамилию обходчика");
      return;
    }
    setPendingDraft({
      district: workDistrict,
      surname,
      testingKind: workKind,
      questions: test.map((question) => ({
        id: question.id,
        categoryId: question.categoryId,
        groupId: question.groupId,
        text: question.text,
        answer: question.answer,
        answerVisible: false,
      })),
    });
    setView("results");
  }

  function toggleCategory(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) {
        setSelectedGroups((themes) => themes.filter((themeId) => groups.find((theme) => theme.id === themeId)?.categoryId !== id));
        return prev.filter((item) => item !== id);
      }
      const categoryThemes = groups.filter((theme) =>
        theme.categoryId === id &&
        questions.some((question) => question.groupId === theme.id && question.active)
      );
      setSelectedGroups((themes) => [...new Set([...themes, ...categoryThemes.map((theme) => theme.id)])]);
      setThemeCounts((counts) => ({
        ...counts,
        ...Object.fromEntries(categoryThemes.map((theme) => [theme.id, counts[theme.id] || 1])),
      }));
      return [...prev, id];
    });
  }

  function toggleTheme(themeId: string) {
    setSelectedGroups((prev) => {
      if (prev.includes(themeId)) return prev.filter((id) => id !== themeId);
      setThemeCounts((counts) => ({ ...counts, [themeId]: counts[themeId] || 1 }));
      return [...prev, themeId];
    });
  }

  function setThemeQuestionCount(themeId: string, value: number) {
    const available = questions.filter((question) => question.groupId === themeId && question.active).length;
    const nextValue = Math.max(1, Math.min(available, Number.isFinite(value) ? value : 1));
    setThemeCounts((counts) => ({ ...counts, [themeId]: nextValue }));
    setSelectedGroups((prev) => prev.includes(themeId) ? prev : [...prev, themeId]);
  }

  function openQuestionEditor(question: Question | null) {
    const topGroupId = question?.categoryId || selected[0] || categories[0]?.id || "";
    const themeId = question?.groupId || groups.find((theme) => theme.categoryId === topGroupId)?.id || "";
    setEditingQuestion(question);
    setQuestionTopGroupId(topGroupId);
    setQuestionThemeId(themeId);
    setQuestionModal(true);
  }

  async function downloadPdf() {
    if (!test.length) return;
    try {
      const [pdfMakeModule, fontsModule] = await Promise.all([
        import("pdfmake/build/pdfmake"),
        import("pdfmake/build/vfs_fonts"),
      ]);
      const pdfMake = pdfMakeModule.default as unknown as {
        addVirtualFileSystem: (fonts: Record<string, string>) => void;
        createPdf: (definition: unknown) => { download: (fileName: string) => Promise<void> };
      };
      pdfMake.addVirtualFileSystem(fontsModule.default as Record<string, string>);
      const questionBlocks = test.map((item, index) => ({
        columns: [
          { text: `${index + 1}.`, width: 24, bold: true, color: "#fa6748" },
          { text: item.text, width: "*", lineHeight: 1.25 },
        ],
        columnGap: 6,
        margin: [0, 0, 0, 12],
      }));
      const answerBlocks = test.map((item, index) => ({
        stack: [
          { text: `${index + 1}. ${item.text}`, bold: true, margin: [0, 0, 0, 5], lineHeight: 1.2 },
          { text: item.answer, color: "#3f4650", lineHeight: 1.3 },
        ],
        margin: [0, 0, 0, 15],
      }));
      await pdfMake.createPdf({
        pageSize: "A4",
        pageMargins: [48, 46, 48, 46],
        defaultStyle: { font: "Roboto", fontSize: 10, color: "#171b22" },
        footer: (currentPage: number, pageCount: number) => ({
          text: `${currentPage} / ${pageCount}`,
          alignment: "right",
          color: "#8a9098",
          fontSize: 8,
          margin: [0, 12, 48, 0],
        }),
        content: [
          { text: "ЭЛЕКТРОННЫЙ ДОМ", color: "#fa6748", bold: true, fontSize: 9, characterSpacing: 1.5 },
          { text: "Проверка знаний", bold: true, fontSize: 22, margin: [0, 5, 0, 3] },
          { text: `Перечень вопросов · ${test.length}`, color: "#7b818b", fontSize: 9, margin: [0, 0, 0, 24] },
          ...questionBlocks,
          { text: "Ответы", bold: true, fontSize: 22, color: "#fa6748", pageBreak: "before", margin: [0, 0, 0, 22] },
          ...answerBlocks,
        ],
      }).download(`Электронный дом — проверка знаний (${test.length}).pdf`);
      setNotice("PDF скачан");
    } catch (error) {
      console.error("PDF generation failed", error);
      setNotice("Не удалось сформировать PDF");
    }
  }

  async function saveQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next: Question = {
      id: editingQuestion?.id || makeId("q"),
      text: String(data.get("text") || "").trim(),
      answer: String(data.get("answer") || "").trim(),
      categoryId: questionTopGroupId,
      groupId: questionThemeId,
      active: data.get("active") === "on",
    };
    if (!next.text || !next.answer) return;
    if (supabase) {
      const payload = {
        id: next.id,
        category_id: next.categoryId,
        group_id: next.groupId,
        question_text: next.text,
        answer_text: next.answer,
        is_active: next.active,
        updated_at: new Date().toISOString(),
      };
      const { error } = editingQuestion
        ? await supabase.from("questions").update(payload).eq("id", next.id)
        : await supabase.from("questions").insert(payload);
      if (error) {
        setNotice("Не удалось сохранить вопрос");
        return;
      }
    }
    setQuestions((prev) => editingQuestion ? prev.map((item) => item.id === next.id ? next : item) : [next, ...prev]);
    setQuestionModal(false);
    setEditingQuestion(null);
    setNotice(editingQuestion ? "Вопрос обновлён" : "Вопрос добавлен");
  }

  async function removeQuestion(id: string) {
    if (!confirm("Удалить этот вопрос?")) return;
    if (supabase) {
      const { error } = await supabase.from("questions").delete().eq("id", id);
      if (error) {
        setNotice("Не удалось удалить вопрос");
        return;
      }
    }
    setQuestions((prev) => prev.filter((item) => item.id !== id));
  }

  async function addCategory(event: React.FormEvent) {
    event.preventDefault();
    const name = categoryDraft.trim();
    if (!name) return;
    const next = { id: makeId("cat"), name, color: "#78828f" };
    if (supabase) {
      const { error } = await supabase.from("categories").insert(next);
      if (error) {
        setNotice("Не удалось добавить группу");
        return;
      }
    }
    setCategories((prev) => [...prev, next]);
    setCategoryDraft("");
    setNotice("Группа добавлена");
  }

  function renameCategory(category: Category) {
    setTaxonomyEdit({ type: "category", id: category.id, name: category.name });
  }

  async function removeCategory(category: Category) {
    if ((activeCounts[category.id] || 0) > 0) {
      setNotice("Сначала перенесите или удалите вопросы этой группы");
      return;
    }
    if (confirm(`Удалить категорию «${category.name}»?`)) {
      if (supabase) {
        const { error } = await supabase.from("categories").delete().eq("id", category.id);
        if (error) {
          setNotice("Не удалось удалить группу");
          return;
        }
      }
      setCategories((prev) => prev.filter((item) => item.id !== category.id));
    }
  }

  async function addGroup(event: React.FormEvent) {
    event.preventDefault();
    const name = groupDraft.trim();
    if (!name) return;
    const next = { id: makeId("group"), categoryId: groupCategoryDraft, name };
    if (supabase) {
      const { error } = await supabase.from("question_groups").insert({
        id: next.id,
        category_id: next.categoryId,
        name: next.name,
      });
      if (error) {
        setNotice("Не удалось добавить тематику");
        return;
      }
    }
    setGroups((prev) => [...prev, next]);
    setGroupDraft("");
    setNotice("Тематика добавлена");
  }

  function renameGroup(group: QuestionGroup) {
    setTaxonomyEdit({ type: "group", id: group.id, name: group.name, categoryId: group.categoryId });
  }

  async function removeGroup(group: QuestionGroup) {
    if (questions.some((question) => question.groupId === group.id)) {
      setNotice("Сначала перенесите или удалите вопросы этой тематики");
      return;
    }
    if (confirm(`Удалить группу «${group.name}»?`)) {
      if (supabase) {
        const { error } = await supabase.from("question_groups").delete().eq("id", group.id);
        if (error) {
          setNotice("Не удалось удалить тематику");
          return;
        }
      }
      setGroups((prev) => prev.filter((item) => item.id !== group.id));
    }
  }

  async function saveTaxonomyEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taxonomyEdit?.name.trim()) return;
    if (taxonomyEdit.type === "category") {
      if (supabase) {
        const { error } = await supabase.from("categories").update({ name: taxonomyEdit.name.trim() }).eq("id", taxonomyEdit.id);
        if (error) {
          setNotice("Не удалось обновить группу");
          return;
        }
      }
      setCategories((prev) => prev.map((item) => item.id === taxonomyEdit.id ? { ...item, name: taxonomyEdit.name.trim() } : item));
    } else {
      const nextCategoryId = taxonomyEdit.categoryId || categories[0]?.id || "";
      if (supabase) {
        const { error: groupError } = await supabase.from("question_groups").update({
          name: taxonomyEdit.name.trim(),
          category_id: nextCategoryId,
        }).eq("id", taxonomyEdit.id);
        if (groupError) {
          setNotice("Не удалось обновить тематику");
          return;
        }
        const { error: questionsError } = await supabase.from("questions").update({ category_id: nextCategoryId }).eq("group_id", taxonomyEdit.id);
        if (questionsError) {
          setNotice("Тематика обновлена, но вопросы не удалось перенести");
          return;
        }
      }
      setGroups((prev) => prev.map((item) => item.id === taxonomyEdit.id ? { ...item, name: taxonomyEdit.name.trim(), categoryId: nextCategoryId } : item));
      setQuestions((prev) => prev.map((question) => question.groupId === taxonomyEdit.id ? { ...question, categoryId: nextCategoryId } : question));
    }
    setTaxonomyEdit(null);
    setNotice("Название обновлено");
  }

  async function updateUserRole(user: User, role: User["role"]) {
    if (supabase) {
      const { error } = await supabase.from("profiles").update({ role }).eq("id", user.id);
      if (error) {
        setNotice("Не удалось изменить роль");
        return;
      }
    }
    setUsers((prev) => prev.map((item) => item.id === user.id ? { ...item, role } : item));
  }

  async function toggleUserBlocked(user: User) {
    const status = user.status === "active" ? "blocked" : "active";
    if (supabase) {
      const { error } = await supabase.from("profiles").update({ is_blocked: status === "blocked" }).eq("id", user.id);
      if (error) {
        setNotice("Не удалось изменить статус пользователя");
        return;
      }
    }
    setUsers((prev) => prev.map((item) => item.id === user.id ? { ...item, status } : item));
  }

  async function renameUser(user: User) {
    const name = prompt("Новое имя пользователя", user.name)?.trim();
    if (!name) return;
    if (supabase) {
      const { error } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
      if (error) {
        setNotice("Не удалось изменить имя пользователя");
        return;
      }
    }
    setUsers((prev) => prev.map((item) => item.id === user.id ? { ...item, name } : item));
    setNotice("Имя пользователя обновлено");
  }

  async function removeUser(user: User) {
    if (user.email === sessionEmail) return;
    if (!confirm(`Отключить учётную запись «${user.name}»? Доступ будет отозван, история сохранится.`)) return;
    if (supabase) {
      const { error } = await supabase.rpc("deactivate_user", { target_user: user.id });
      if (error) {
        setNotice("Не удалось отключить учётную запись");
        return;
      }
    }
    setUsers((prev) => prev.filter((item) => item.id !== user.id));
    setNotice("Учётная запись отключена. История сохранена.");
  }

  if (recovering) return <PasswordRecovery onDone={() => { setRecovering(false); setSessionEmail(""); setSessionUserId(""); setNotice("Пароль изменён. Войдите в сервис."); }} />;
  if (!ready) return <div className="loading"><span /></div>;
  if (!currentUser) {
    return (
      <main className="auth-page">
        <section className="auth-brand">
          <div className="brand-mark large">ЭД</div>
          <div>
            <p className="eyebrow">ЭЛЕКТРОННЫЙ ДОМ</p>
            <h1>Проверка<br />знаний</h1>
          </div>
          <div className="auth-brand-footer">
            <div className="auth-stat"><b>{sessionUserId ? questions.length : databaseQuestionCount}</b><span>вопросов уже в базе</span></div>
            <div className="dev-signature" aria-label="IL2 DEV">
              <span className="dev-signature-image" style={{ width: 48, height: 48, border: "none", outline: "none", background: "transparent", boxShadow: "none" }}>
                <span role="img" aria-label="" style={{ display: "block", width: 48, height: 48, background: "url(/il2-dev-black.png) center / contain no-repeat" }} />
              </span>
              <b style={{ fontSize: 12, letterSpacing: 1.4, paddingBottom: 5 }}>IL2 DEV</b>
            </div>
          </div>
        </section>
        <section className="auth-form-wrap">
          <form className="auth-card" onSubmit={authSubmit}>
            <div className="mobile-brand"><div className="brand-mark">ЭД</div><b>Проверка знаний</b></div>
            <p className="eyebrow">{authMode === "register" ? "НОВАЯ УЧЁТНАЯ ЗАПИСЬ" : authMode === "reset" ? "ВОССТАНОВЛЕНИЕ ДОСТУПА" : "ДОБРО ПОЖАЛОВАТЬ"}</p>
            <h2>{authMode === "register" ? "Регистрация" : authMode === "reset" ? "Сброс пароля" : "Вход в сервис"}</h2>
            <p className="muted">{authMode === "reset" ? "Укажите почту — мы отправим инструкцию." : "Используйте рабочую электронную почту."}</p>
            {authMode === "register" && <label>Имя<input name="name" required /></label>}
            <label>Электронная почта<input name="email" type="email" required autoComplete="email" placeholder="name@example.ru" /></label>
            {authMode !== "reset" && <label>Пароль<input name="password" type="password" required autoComplete={authMode === "register" ? "new-password" : "current-password"} minLength={authMode === "register" ? 12 : undefined} placeholder={authMode === "register" ? "Не менее 12 символов" : "Ваш пароль"} /></label>}
            {authError && <div className="auth-error">{authError}</div>}
            <button className="primary full" type="submit" disabled={authSubmitting}>{authSubmitting ? "Подключаемся…" : authMode === "register" ? "Создать аккаунт" : authMode === "reset" ? "Отправить инструкцию" : "Войти"}</button>
            {authMode === "login" && <button className="text-button" type="button" onClick={() => setAuthMode("reset")}>Забыли пароль?</button>}
            <div className="auth-switch">
              {authMode === "login" ? <>Нет аккаунта? <button type="button" onClick={() => setAuthMode("register")}>Зарегистрироваться</button></> : <>Уже есть аккаунт? <button type="button" onClick={() => setAuthMode("login")}>Войти</button></>}
            </div>
          </form>
        </section>
      </main>
    );
  }

  const nav: { id: View; label: string; icon: "home" | "results" | "questions" | "categories" | "users"; admin?: boolean }[] = [
    { id: "generator", label: "Генератор", icon: "home" },
    { id: "results", label: "Результаты", icon: "results" },
    { id: "questions", label: "База вопросов", icon: "questions", admin: true },
    { id: "categories", label: "Группы и тематики", icon: "categories", admin: true },
    { id: "users", label: "Пользователи", icon: "users", admin: true },
  ];

  const visibleQuestions = questions.filter((question) =>
    (questionCategory === "all" || question.categoryId === questionCategory) &&
    (question.text.toLowerCase().includes(questionSearch.toLowerCase()) || question.answer.toLowerCase().includes(questionSearch.toLowerCase()))
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <div className="sidebar-brand"><div className="brand-mark">ЭД</div><div><b>Электронный дом</b><span>Проверка знаний</span></div><button className="mobile-close" onClick={() => setMobileMenu(false)}><Icon name="close" /></button></div>
        <nav>
          {nav.filter((item) => !item.admin || isAdmin).map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMobileMenu(false); }}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.id === "questions" && <small>{questions.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{currentUser.name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</div>
          <div><b>{currentUser.name}</b><span>{currentUser.role === "admin" ? "Администратор" : "Пользователь"}</span></div>
          <button title="Выйти" onClick={signOut}><Icon name="logout" /></button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileMenu(true)}><Icon name="menu" /></button>
          <div><span>Электронный дом</span><b>{view === "generator" ? "Генератор вопросов" : nav.find((item) => item.id === view)?.label}</b></div>
          <div className="topbar-user"><span>{currentUser.email}</span><div className="avatar small">{currentUser.name[0]}</div></div>
        </header>

        {view === "generator" && (
          <div className="page generator-page">
            <div className="page-heading">
              <div><p className="eyebrow">ПОДГОТОВКА К ОБХОДУ</p><h1>Соберите перечень вопросов</h1><p>Выберите группы и задайте нужное количество вопросов отдельно для каждой тематики.</p></div>
              {test.length > 0 && <button className="secondary desktop-only" onClick={downloadPdf}><Icon name="download" /> Скачать PDF</button>}
            </div>

            <section className="config-card">
              <div className="config-main">
                <div className="section-label"><div><b>Группы</b><small>Можно выбрать несколько</small></div></div>
                <div className="category-grid">
                  {categories.map((category) => {
                    const count = activeCounts[category.id] || 0;
                    return <button key={category.id} disabled={!count} className={`category-option ${selected.includes(category.id) ? "selected" : ""}`} onClick={() => toggleCategory(category.id)}>
                      <span className="checkbox">{selected.includes(category.id) && "✓"}</span>
                      <span><b>{category.name}</b><small>{count ? `${count} ${count === 1 ? "вопрос" : count < 5 ? "вопроса" : "вопросов"}` : "Пока нет вопросов"}</small></span>
                    </button>;
                  })}
                </div>
                {groups.some((group) => selected.includes(group.categoryId)) && <div className="group-picker">
                  <div className="group-picker-title">
                    <b>Тематики</b>
                    <span>Укажите нужное количество вопросов отдельно для каждой тематики</span>
                  </div>
                  <div className="theme-count-grid">
                    {groups.filter((group) => selected.includes(group.categoryId)).map((group) => {
                      const count = questions.filter((question) => question.groupId === group.id && question.active).length;
                      const active = selectedGroups.includes(group.id);
                      return <div key={group.id} className={`theme-count-item ${active ? "active" : ""}`}>
                        <button type="button" className="theme-toggle" onClick={() => toggleTheme(group.id)}>
                          <span className="checkbox">{active && "✓"}</span>
                          <span><b>{group.name}</b><small>Доступно: {count}</small></span>
                        </button>
                        <div className="theme-counter">
                          <button type="button" disabled={!active || (themeCounts[group.id] || 1) <= 1} onClick={() => setThemeQuestionCount(group.id, (themeCounts[group.id] || 1) - 1)}>−</button>
                          <input
                            aria-label={`Количество вопросов по тематике «${group.name}»`}
                            type="number"
                            min="1"
                            max={count}
                            disabled={!active}
                            value={themeCounts[group.id] || 1}
                            onChange={(event) => setThemeQuestionCount(group.id, Number(event.target.value))}
                          />
                          <button type="button" disabled={!active || (themeCounts[group.id] || 1) >= count} onClick={() => setThemeQuestionCount(group.id, (themeCounts[group.id] || 1) + 1)}>+</button>
                        </div>
                      </div>;
                    })}
                  </div>
                </div>}
              </div>
              <div className="config-side">
                <div className="section-label"><div><b>Итого</b><small>Вопросов в перечне</small></div></div>
                <div className="total-count">{questionCount}</div>
                <p className="total-hint">Сумма настроек по выбранным тематикам</p>
              </div>
              <button className="primary generate" onClick={generateTest}><Icon name="shuffle" /> {test.length ? "Сгенерировать заново" : "Сформировать вопросы"}</button>
            </section>

            {test.length ? (
              <section className="test-section">
                <div className="test-toolbar">
                  <div><p className="eyebrow">ГОТОВЫЙ ПЕРЕЧЕНЬ</p><h2>{test.length} вопросов</h2></div>
                  <div>
                    <button className="ghost" onClick={() => {
                      const shouldShow = !test.every((item) => item.answerVisible);
                      setTest((prev) => prev.map((item) => ({ ...item, answerVisible: shouldShow })));
                    }}><Icon name="eye" /> {test.every((item) => item.answerVisible) ? "Скрыть все ответы" : "Показать все ответы"}</button>
                    <button className="secondary mobile-pdf" onClick={downloadPdf}><Icon name="download" /> PDF</button>
                  </div>
                </div>
                <div className="question-list">
                  {test.map((item, index) => {
                    const category = categories.find((cat) => cat.id === item.categoryId);
                    return <article className="test-question" key={`${item.id}-${index}`}>
                      <div className="question-number">{String(index + 1).padStart(2, "0")}</div>
                      <div className="question-content">
                        <span className="tag">{category?.name}</span>
                        <span className="tag group-tag">{groups.find((group) => group.id === item.groupId)?.name}</span>
                        <h3>{item.text}</h3>
                        {item.answerVisible && <div className="answer"><b>Ответ</b><p>{item.answer}</p></div>}
                        <div className="question-actions">
                          <button onClick={() => setTest((prev) => prev.map((question, itemIndex) => itemIndex === index ? { ...question, answerVisible: !question.answerVisible } : question))}><Icon name="eye" /> {item.answerVisible ? "Скрыть ответ" : "Показать ответ"}</button>
                          <button onClick={() => replaceQuestion(index)}><Icon name="shuffle" /> Заменить вопрос</button>
                        </div>
                      </div>
                    </article>;
                  })}
                </div>
                <div className="take-work-panel">
                  <div className="result-form-grid">
                    <label>Округ<select value={workDistrict} onChange={(event) => setWorkDistrict(event.target.value)}>{MOSCOW_DISTRICTS.map((district) => <option key={district}>{district}</option>)}</select></label>
                    <label>Фамилия<input required value={workSurname} onChange={(event) => setWorkSurname(event.target.value)} placeholder="Введите фамилию" /></label>
                  </div>
                  <label className="toggle-label result-kind"><input type="checkbox" checked={workKind === "repeat"} onChange={(event) => setWorkKind(event.target.checked ? "repeat" : "first")} /><span /> {workKind === "repeat" ? "Повторное тестирование" : "Первое тестирование"}</label>
                  <button className="primary" type="button" onClick={takeGeneratedTestToWork}>Взять в работу</button>
                </div>
              </section>
            ) : (
              <section className="empty-state"><div className="empty-illustration"><span>?</span><span>✓</span><span>А</span></div><h2>Здесь появится ваш перечень</h2><p>Настройте параметры выше и нажмите «Сформировать вопросы».</p></section>
            )}
          </div>
        )}

        <div hidden={view !== "results"}>
          <TestingResults
            userId={sessionUserId}
            userEmail={sessionEmail}
            isAdmin={isAdmin}
            onNotice={setNotice}
            incomingDraft={pendingDraft}
            onDraftAccepted={() => setPendingDraft(null)}
          />
        </div>

        {view === "questions" && isAdmin && (
          <div className="page admin-page">
            <div className="page-heading"><div><p className="eyebrow">АДМИНИСТРИРОВАНИЕ</p><h1>База вопросов</h1><p>Добавляйте и актуализируйте материалы для обходчиков.</p></div><button className="primary" onClick={() => openQuestionEditor(null)}><Icon name="plus" /> Добавить вопрос</button></div>
            <div className="filterbar"><input placeholder="Поиск по вопросу или ответу" value={questionSearch} onChange={(e) => setQuestionSearch(e.target.value)} /><select value={questionCategory} onChange={(e) => setQuestionCategory(e.target.value)}><option value="all">Все группы</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><span>Найдено: {visibleQuestions.length}</span></div>
            <div className="data-table questions-table">
              <div className="table-head"><span>Вопрос</span><span>Группа / тематика</span><span>Статус</span><span></span></div>
              {visibleQuestions.map((question) => <div className="table-row" key={question.id}>
                <div><b>{question.text}</b><p>{question.answer}</p></div>
                <div className="taxonomy-cell"><span className="tag">{categories.find((item) => item.id === question.categoryId)?.name}</span><small>{groups.find((item) => item.id === question.groupId)?.name || "Без группы"}</small></div>
                <span className={`status ${question.active ? "ok" : ""}`}><i />{question.active ? "Активен" : "Скрыт"}</span>
                <div className="row-actions"><button title="Редактировать" onClick={() => openQuestionEditor(question)}><Icon name="edit" /></button><button title="Удалить" onClick={() => removeQuestion(question.id)}><Icon name="trash" /></button></div>
              </div>)}
            </div>
          </div>
        )}

        {view === "categories" && isAdmin && (
          <div className="page admin-page">
            <div className="page-heading"><div><p className="eyebrow">СТРУКТУРА БАЗЫ</p><h1>Группы и тематики</h1><p>Сначала создайте группу, затем добавьте в неё нужные тематики.</p></div></div>
            <div className="taxonomy-section">
              <div className="taxonomy-heading"><h2>Группы</h2><p>Верхний уровень структуры</p></div>
              <form className="add-category" onSubmit={addCategory}><input placeholder="Название новой группы" value={categoryDraft} onChange={(e) => setCategoryDraft(e.target.value)} /><button className="primary"><Icon name="plus" /> Добавить</button></form>
            <div className="category-admin-grid">{categories.map((category) => <article key={category.id}>
              <div className="category-icon"><Icon name="categories" /></div>
              <div><b>{category.name}</b><span>{activeCounts[category.id] || 0} вопросов</span></div>
              <div className="row-actions"><button title={`Редактировать группу «${category.name}»`} aria-label={`Редактировать группу «${category.name}»`} onClick={() => renameCategory(category)}><Icon name="edit" /></button><button title={`Удалить группу «${category.name}»`} aria-label={`Удалить группу «${category.name}»`} onClick={() => removeCategory(category)}><Icon name="trash" /></button></div>
            </article>)}</div>
            </div>
            <div className="taxonomy-section">
              <div className="taxonomy-heading"><h2>Тематики</h2><p>Вложены в выбранную группу</p></div>
              <form className="add-category group-form" onSubmit={addGroup}>
              <select value={groupCategoryDraft} onChange={(e) => setGroupCategoryDraft(e.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
              <input placeholder="Название новой тематики" value={groupDraft} onChange={(e) => setGroupDraft(e.target.value)} />
              <button className="primary"><Icon name="plus" /> Добавить</button>
            </form>
            <div className="category-admin-grid">{groups.map((group) => <article key={group.id}>
              <div className="category-icon"><Icon name="questions" /></div>
              <div><b>{group.name}</b><span>Группа: {categories.find((category) => category.id === group.categoryId)?.name} · {questions.filter((question) => question.groupId === group.id).length} вопросов</span></div>
              <div className="row-actions"><button title={`Редактировать тематику «${group.name}»`} aria-label={`Редактировать тематику «${group.name}»`} onClick={() => renameGroup(group)}><Icon name="edit" /></button><button title={`Удалить тематику «${group.name}»`} aria-label={`Удалить тематику «${group.name}»`} onClick={() => removeGroup(group)}><Icon name="trash" /></button></div>
            </article>)}</div>
            </div>
          </div>
        )}

        {view === "users" && isAdmin && (
          <div className="page admin-page">
            <div className="page-heading"><div><p className="eyebrow">ДОСТУП К СЕРВИСУ</p><h1>Пользователи</h1><p>Назначайте администраторов и управляйте доступом.</p></div><div className="summary-pill"><b>{users.length}</b><span>учётных записей</span></div></div>
            <div className="data-table users-table">
              <div className="table-head"><span>Пользователь</span><span>Роль</span><span>Статус</span><span>Управление</span></div>
              {users.map((user) => <div className="table-row" key={user.id}>
                <div className="user-cell"><div className="avatar">{user.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div><div><b>{user.name}</b><span>{user.email}</span></div></div>
                <span className={`role ${user.role}`}>{user.role === "admin" ? "Администратор" : "Пользователь"}</span>
                <span className={`status ${user.status === "active" ? "ok" : ""}`}><i />{user.deactivated ? "Отключён" : user.status === "active" ? "Активен" : "Ожидает допуска / заблокирован"}</span>
                <div className="user-controls">
                  <select disabled={user.email === sessionEmail || user.deactivated} value={user.role} onChange={(e) => updateUserRole(user, e.target.value as User["role"])}><option value="user">Пользователь</option><option value="admin">Администратор</option></select>
                  <button disabled={user.email === sessionEmail || user.deactivated} onClick={() => toggleUserBlocked(user)}>{user.status === "active" ? "Заблокировать" : "Разблокировать"}</button>
                  <button disabled={user.deactivated} onClick={() => renameUser(user)}>Имя</button>
                  <button disabled={user.email === sessionEmail || user.deactivated} onClick={() => removeUser(user)}>Отключить</button>
                </div>
              </div>)}
            </div>
          </div>
        )}
      </main>

      {mobileMenu && <button className="menu-backdrop" aria-label="Закрыть меню" onClick={() => setMobileMenu(false)} />}
      {notice && <div className="toast">✓ <span>{notice}</span></div>}
      {questionModal && <div className="modal-backdrop" onMouseDown={() => setQuestionModal(false)}><form className="modal" onSubmit={saveQuestion} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title"><div><p className="eyebrow">БАЗА ЗНАНИЙ</p><h2>{editingQuestion ? "Редактирование вопроса" : "Новый вопрос"}</h2></div><button type="button" onClick={() => setQuestionModal(false)}><Icon name="close" /></button></div>
        <label>Группа<select value={questionTopGroupId} onChange={(event) => {
          const nextGroupId = event.target.value;
          setQuestionTopGroupId(nextGroupId);
          setQuestionThemeId(groups.find((theme) => theme.categoryId === nextGroupId)?.id || "");
        }}>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
        <label>Тематика<select value={questionThemeId} onChange={(event) => setQuestionThemeId(event.target.value)} required>
          {groups.filter((theme) => theme.categoryId === questionTopGroupId).map((theme) => <option value={theme.id} key={theme.id}>{theme.name}</option>)}
        </select></label>
        <label>Вопрос<textarea name="text" required rows={4} defaultValue={editingQuestion?.text} placeholder="Введите формулировку вопроса" /></label>
        <label>Ответ<textarea name="answer" required rows={7} defaultValue={editingQuestion?.answer} placeholder="Введите правильный ответ" /></label>
        <label className="toggle-label"><input type="checkbox" name="active" defaultChecked={editingQuestion?.active ?? true} /><span /> Использовать при генерации</label>
        <div className="modal-actions"><button type="button" className="ghost" onClick={() => setQuestionModal(false)}>Отмена</button><button className="primary" type="submit">Сохранить</button></div>
      </form></div>}
      {taxonomyEdit && <div className="modal-backdrop" onMouseDown={() => setTaxonomyEdit(null)}><form className="modal compact-modal" onSubmit={saveTaxonomyEdit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><p className="eyebrow">СТРУКТУРА БАЗЫ</p><h2>Редактирование {taxonomyEdit.type === "category" ? "группы" : "тематики"}</h2></div><button type="button" onClick={() => setTaxonomyEdit(null)}><Icon name="close" /></button></div>
        {taxonomyEdit.type === "group" && <label>Группа<select value={taxonomyEdit.categoryId} onChange={(event) => setTaxonomyEdit({ ...taxonomyEdit, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
        <label>Название<input autoFocus value={taxonomyEdit.name} onChange={(event) => setTaxonomyEdit({ ...taxonomyEdit, name: event.target.value })} /></label>
        <div className="modal-actions"><button type="button" className="ghost" onClick={() => setTaxonomyEdit(null)}>Отмена</button><button className="primary" type="submit">Сохранить</button></div>
      </form></div>}
    </div>
  );
}

