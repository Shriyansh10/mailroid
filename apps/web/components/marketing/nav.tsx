"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X } from "lucide-react";
import { cn } from "@web/lib/utils";
import { Button } from "./primitives/button";
import { NAV_LINKS, NAV_PRICING } from "./content";
import logo from "@web/assets/Logo/mailroid-no-background.png";

/**
 * Sticky nav. Transparent over the indigo hero, then cross-fades to a
 * blurred white bar once the fold is behind you — DESIGN.md's nav-bar-dark
 * and nav-bar-light, as one component rather than two.
 */
export function Nav() {
  const [lifted, setLifted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A menu that stays open behind you when the viewport widens is a trap.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const close = () => setOpen(false);
    mq.addEventListener("change", close);
    return () => mq.removeEventListener("change", close);
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50",
        "transition-[background-color,border-color,backdrop-filter] duration-300 ease-out",
        lifted
          ? "border-b border-mr-line bg-mr-canvas/85 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-[1100px] items-center gap-6 px-6 md:h-[72px] md:px-10"
      >
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current"
        >
          <Image src={logo} alt="" width={26} height={26} className="size-[26px] object-contain" priority />
          <span className={cn("t-lead w600 transition-colors duration-300", lifted ? "text-mr-ink" : "text-white")}>
            Mailroid
          </span>
        </Link>

        <ul className="ml-auto hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className={cn(
                  "t-cap w540 transition-colors duration-200 rounded-sm",
                  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current",
                  lifted
                    ? "text-mr-mute hover:text-mr-ink"
                    : "text-white/70 hover:text-white",
                )}
              >
                {l.label}
              </Link>
            </li>
          ))}
          {/* Not a link and not focusable — there is nothing to show yet, and a
              nav item that goes nowhere is worse than one that isn't there. */}
          <li className="flex flex-col items-center leading-none">
            <span className={cn("t-cap w540", lifted ? "text-mr-faint" : "text-white/40")}>
              {NAV_PRICING.label}
            </span>
            <span
              className={cn(
                "mt-1 text-[0.625rem] w600 uppercase tracking-[0.14em]",
                lifted ? "text-mr-faint/70" : "text-white/30",
              )}
            >
              {NAV_PRICING.note}
            </span>
          </li>
        </ul>

        <div className="ml-auto flex items-center gap-4 lg:ml-0">
          <Link
            href="/sign-in"
            className={cn(
              "hidden t-cap w540 transition-colors duration-200 rounded-sm sm:block",
              "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current",
              lifted ? "text-mr-mute hover:text-mr-ink" : "text-white/70 hover:text-white",
            )}
          >
            Sign in
          </Link>
          <div className="hidden sm:block">
            {lifted ? (
              <Button href="/sign-in" variant="solid" className="px-4 py-2 t-cap">
                Get started
              </Button>
            ) : (
              <Button href="/sign-in" variant="navSolid">
                Get started
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mr-mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            className={cn(
              "grid size-10 place-items-center rounded-lg transition-colors duration-200 lg:hidden",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
              lifted ? "text-mr-ink hover:bg-mr-soft" : "text-white hover:bg-white/10",
            )}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div
          id="mr-mobile-nav"
          className="border-t border-mr-line bg-mr-canvas px-6 pb-6 pt-2 lg:hidden"
        >
          <ul className="flex flex-col">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-mr-line/70 py-3.5 t-lead w460 text-mr-ink"
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="flex items-baseline gap-2 border-b border-mr-line/70 py-3.5">
              <span className="t-lead w460 text-mr-faint">{NAV_PRICING.label}</span>
              <span className="text-[0.625rem] w600 uppercase tracking-[0.14em] text-mr-faint/70">
                {NAV_PRICING.note}
              </span>
            </li>
          </ul>
          <div className="mt-5 flex items-center gap-3">
            <Button href="/sign-in" variant="solid" full>
              Get started
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
