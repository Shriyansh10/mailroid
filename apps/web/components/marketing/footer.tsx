import Link from "next/link";
import Image from "next/image";
import { Micro, Caption } from "./primitives/type";
import { footer } from "./content";
import logo from "@web/assets/Logo/mailroid-no-background.png";

/**
 * No GitHub link. The repository URL isn't settled and a nav item that goes
 * nowhere is worse than one that isn't there — add it back here under
 * "Trust" once there's a public repo to point at.
 */
export function Footer() {
  return (
    <footer className="bg-mr-canvas">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-16 md:px-10 md:py-20">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,auto))] lg:gap-16">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mr-indigo"
            >
              <Image src={logo} alt="" width={24} height={24} className="size-6 object-contain" />
              <span className="t-lead w600 text-mr-ink">Mailroid</span>
            </Link>
            <Caption className="mt-4 max-w-[22rem] text-mr-faint">
              An AI workspace built on top of Gmail and Google Calendar.
            </Caption>
          </div>

          {footer.columns.map((col) => (
            <div key={col.heading}>
              <Micro className="text-mr-faint">{col.heading}</Micro>
              <ul className="mt-4 flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className={[
                        "t-cap w460 text-mr-mute transition-colors duration-200 hover:text-mr-ink",
                        "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mr-indigo",
                      ].join(" ")}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t border-mr-line pt-7">
          <Caption className="text-mr-faint">{footer.legal}</Caption>
          <Caption className="text-mr-faint">Free while it&apos;s in beta.</Caption>
        </div>
      </div>
    </footer>
  );
}
