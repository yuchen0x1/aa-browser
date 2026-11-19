/* ==========================================================================
   Aa Browser — marketing site interactions
   No dependencies. Everything degrades without JS.
   ========================================================================== */
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  /* ---------- Toast ---------- */
  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      Object.assign(toastEl.style, {
        position: "fixed",
        left: "50%",
        bottom: "26px",
        zIndex: "80",
        transform: "translate(-50%, 12px)",
        padding: "9px 15px",
        border: "1px solid rgba(120,203,185,.4)",
        borderRadius: "8px",
        background: "rgba(10,16,18,.96)",
        color: "#d8fbf1",
        fontFamily: '"Cascadia Code", Consolas, monospace',
        fontSize: "12px",
        letterSpacing: "0.02em",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity .2s ease, transform .2s ease",
      });
      document.body.appendChild(toastEl);
    }

    toastEl.textContent = message;
    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translate(-50%, 0)";
    });

    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translate(-50%, 12px)";
    }, 1800);
  }

  async function copyText(text) {
    if (!text) return false;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }

    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.top = "-1000px";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();

    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    helper.remove();
    return ok;
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy], [data-copy-target]");
    if (!button) return;

    let text = button.getAttribute("data-copy") || "";

    if (!text && button.getAttribute("data-copy-target") === "demoActive") {
      const active = $(".demo__panel.is-active");
      if (active) {
        text = $$(".code__row", active)
          .map((row) => {
            const tx = $(".code__tx", row);
            return tx ? tx.textContent.replace(/\u00a0/g, " ") : "";
          })
          .join("\n");
      }
    }

    const ok = await copyText(text.trim());
    if (!ok) {
      toast("复制失败，请手动选择");
      return;
    }

    button.classList.add("is-copied");
    window.setTimeout(() => button.classList.remove("is-copied"), 1400);
    toast("已复制到剪贴板");
  });

  /* ---------- Header / mobile nav ---------- */
  const header = $("#siteHeader");
  const navToggle = $("#navToggle");
  const navLinks = $("#navLinks");

  function setNavOpen(open) {
    if (!header || !navToggle) return;
    header.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    document.body.classList.toggle("is-locked", open);
  }

  if (navToggle) {
    navToggle.addEventListener("click", () => {
      setNavOpen(!header.classList.contains("is-open"));
    });

    navLinks?.addEventListener("click", (event) => {
      if (event.target.closest("a")) setNavOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.classList.contains("is-open")) {
        setNavOpen(false);
        navToggle.focus();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 860) setNavOpen(false);
    });
  }

  function onScroll() {
    if (!header) return;
    const y = window.scrollY;
    header.classList.toggle("is-stuck", y > 8);

    // Above the first section there is no active nav target; don't leave the
    // previously highlighted item stuck on while the hero is in view. Only
    // hash links are section links — "手册" on the tools page is a real page.
    if (y < 120) {
      $$(".nav__link.is-current").forEach((link) => {
        if ((link.getAttribute("href") || "").startsWith("#")) {
          link.classList.remove("is-current");
        }
      });
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Reveal on scroll ---------- */
  const revealTargets = $$("[data-reveal]");

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealTargets.forEach((el) => el.classList.add("is-in"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    revealTargets.forEach((el) => revealObserver.observe(el));
  }

  /* ---------- Active nav section ---------- */
  const sectionLinks = $$(".nav__link").filter((link) => {
    const href = link.getAttribute("href") || "";
    return href.startsWith("#") && href.length > 1;
  });

  if (sectionLinks.length && "IntersectionObserver" in window) {
    const byId = new Map(
      sectionLinks.map((link) => [link.getAttribute("href").slice(1), link])
    );

    const sections = Array.from(byId.keys())
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    const navObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;

        sectionLinks.forEach((link) => link.classList.remove("is-current"));
        byId.get(visible.target.id)?.classList.add("is-current");
      },
      { rootMargin: "-35% 0px -55% 0px", threshold: [0, 0.2, 0.6] }
    );

    sections.forEach((section) => navObserver.observe(section));
  }

  /* ---------- Demo tabs ---------- */
  const demoTabs = $$(".demo__step");
  const demoPanels = $$(".demo__panel");
  const demo = $(".demo");

  if (demoTabs.length && demoPanels.length) {
    let index = demoPanels.findIndex((panel) => panel.classList.contains("is-active"));
    if (index < 0) index = 0;

    let autoTimer = null;
    let userPaused = false;
    let inView = true;

    const stopAuto = () => {
      window.clearInterval(autoTimer);
      autoTimer = null;
    };

    const startAuto = () => {
      stopAuto();
      if (reduceMotion || userPaused || !inView) return;
      autoTimer = window.setInterval(() => select((index + 1) % demoTabs.length, false), 8000);
    };

    function select(next, focusTab) {
      index = ((next % demoTabs.length) + demoTabs.length) % demoTabs.length;

      demoTabs.forEach((tab, i) => {
        const selected = i === index;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });

      demoPanels.forEach((panel, i) => panel.classList.toggle("is-active", i === index));

      if (focusTab) demoTabs[index].focus();
      startAuto();
    }

    demoTabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        userPaused = true;
        select(i, false);
      });

      tab.addEventListener("keydown", (event) => {
        const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        userPaused = true;

        let next = index;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index + 1;
        if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index - 1;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = demoTabs.length - 1;
        select(next, true);
      });
    });

    demo.addEventListener("mouseenter", stopAuto);
    demo.addEventListener("mouseleave", () => {
      if (!userPaused) startAuto();
    });
    demo.addEventListener("focusin", stopAuto);
    demo.addEventListener("focusout", (event) => {
      if (!demo.contains(event.relatedTarget) && !userPaused) startAuto();
    });

    if ("IntersectionObserver" in window) {
      const demoObserver = new IntersectionObserver(
        (entries) => {
          inView = entries[0]?.isIntersecting ?? true;
          if (inView && !userPaused) startAuto();
          else stopAuto();
        },
        { threshold: 0.25 }
      );
      demoObserver.observe(demo);
    } else {
      startAuto();
    }

    select(index, false);
  }

  /* ---------- Tools page: search + filters ---------- */
  const toolSearch = $("#toolSearch");
  const toolList = $("#toolList");
  const toolCount = $("#toolCount");
  const toolScope = $("#toolScope");
  const toolsEmpty = $("#toolsEmpty");
  const filterButtons = $$(".filter");

  if (toolSearch && toolList) {
    const tools = $$(".tool", toolList);
    let activeCategory = "all";

    const categoryLabels = {
      all: "全部分类",
      nav: "导航与快照",
      interact: "交互",
      read: "读取与状态",
      network: "网络与 Mock",
      diag: "诊断与标签",
    };

    function apply() {
      const query = toolSearch.value.trim().toLowerCase();
      let visible = 0;

      tools.forEach((tool) => {
        const category = tool.dataset.category || "";
        const haystack = (tool.dataset.search || "") + " " + tool.textContent.toLowerCase();
        const matchCategory = activeCategory === "all" || category === activeCategory;
        const matchQuery = !query || haystack.includes(query);
        const show = matchCategory && matchQuery;

        tool.hidden = !show;
        if (show) visible += 1;
      });

      if (toolCount) toolCount.textContent = String(visible);
      if (toolScope) toolScope.textContent = categoryLabels[activeCategory] || "全部分类";
      toolsEmpty?.classList.toggle("is-visible", visible === 0);
    }

    filterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        activeCategory = button.dataset.filter || "all";
        filterButtons.forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button))
        );
        apply();
      });
    });

    toolSearch.addEventListener("input", () => {
      // Typing searches across all categories; the category chip resets so a
      // known tool name never returns an empty list because of a stale filter.
      if (toolSearch.value.trim() && activeCategory !== "all") {
        activeCategory = "all";
        filterButtons.forEach((item) =>
          item.setAttribute("aria-pressed", String(item.dataset.filter === "all"))
        );
      }
      apply();
    });

    document.addEventListener("keydown", (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        toolSearch.focus();
        toolSearch.select();
      }
    });

    document.addEventListener("click", (event) => {
      const anchor = event.target.closest('.tools-side a[href^="#"], .tool-cat[href^="tools.html#"]');
      if (!anchor) return;

      const hash = (anchor.getAttribute("href") || "").split("#")[1];
      if (!hash || !(hash in categoryLabels)) return;

      const target = filterButtons.find((button) => button.dataset.filter === hash);
      if (target) {
        target.click();
      }
    });

    const initialHash = window.location.hash.replace("#", "");
    if (initialHash && initialHash in categoryLabels && initialHash !== "all") {
      const target = filterButtons.find((button) => button.dataset.filter === initialHash);
      target?.click();
    }

    apply();
  }
})();
