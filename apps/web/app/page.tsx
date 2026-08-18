import { Nav } from "@web/components/marketing/nav";
import { Footer } from "@web/components/marketing/footer";
import { HeroSection } from "@web/components/marketing/sections/hero";
import { WorksWith } from "@web/components/marketing/sections/works-with";
import { Philosophy, Beat } from "@web/components/marketing/sections/philosophy";
import { Scheduling } from "@web/components/marketing/sections/scheduling";
import { InboxAndAi } from "@web/components/marketing/sections/inbox-and-ai";
import { Trust } from "@web/components/marketing/sections/trust";
import { PoweredBy } from "@web/components/marketing/sections/powered-by";
import { Faq } from "@web/components/marketing/sections/faq";
import { FinalCta } from "@web/components/marketing/sections/final-cta";

/**
 * The landing page.
 *
 * A server component: only the nav, the reveal primitive, the FAQ and the
 * scheduling stage ship JavaScript. Every product mockup is DOM built from
 * the design tokens, so the page carries no images beyond the logo.
 *
 * `.mailroid-marketing` is load-bearing, not cosmetic. next-themes puts
 * `.dark` on <html> whenever the visitor's OS is dark, which would invert a
 * white editorial page; the wrapper's tokens are literals and nothing
 * inside uses `bg-background` or `text-foreground`, so the page renders the
 * same either way. See the note at the top of globals.css.
 *
 * The order is the argument:
 *   fold → objection → problem → the beat → the differentiator →
 *   what it does → why it can be trusted → who's behind it → doubts → close
 */
export default function LandingPage() {
  return (
    <div className="mailroid-marketing">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-6 focus:top-6 focus:z-[60] focus:rounded-lg focus:bg-mr-indigo focus:px-4 focus:py-2.5 focus:t-cap focus:w600 focus:text-white"
      >
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <HeroSection />
        <WorksWith />
        <Philosophy />
        <Beat />
        <Scheduling />
        <InboxAndAi />
        <Trust />
        <PoweredBy />
        <Faq />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}
