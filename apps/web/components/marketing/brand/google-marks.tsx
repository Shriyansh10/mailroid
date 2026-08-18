/**
 * Gmail and Google Calendar marks, inline SVG in Google's own brand colours.
 *
 * Inline rather than <img> so they stay crisp at any size, carry no network
 * request, and inherit the page's own sizing. Drawn to Google's published
 * geometry — do not recolour them; a recoloured Google mark reads as a
 * counterfeit and the whole point of this section is borrowed trust.
 */

export function GmailMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 52 40"
      role="img"
      aria-label="Gmail"
      className={className}
      focusable="false"
    >
      <path fill="#4285F4" d="M3.64 40h8.18V20.18L0 11v25.36A3.64 3.64 0 0 0 3.64 40Z" />
      <path fill="#34A853" d="M40.18 40h8.18A3.64 3.64 0 0 0 52 36.36V11l-11.82 9.18V40Z" />
      <path fill="#FBBC04" d="M40.18 3.64v16.54L52 11V5.45c0-4.5-5.14-7.06-8.73-4.36l-3.09 2.55Z" />
      <path fill="#EA4335" d="M11.82 20.18V3.64L26 14.27 40.18 3.64v16.54L26 30.81 11.82 20.18Z" />
      <path fill="#C5221F" d="M0 5.45V11l11.82 9.18V3.64L8.73 1.09C5.14-1.61 0 .95 0 5.45Z" />
    </svg>
  );
}

export function CalendarMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="Google Calendar"
      className={className}
      focusable="false"
    >
      <path fill="#FFF" d="M11 11h26v26H11z" />
      <path fill="#1A73E8" d="M37 48 48 37H37v11Z" />
      <path fill="#EA4335" d="M48 11V5a5 5 0 0 0-5-5h-6v11h11Z" />
      <path fill="#4285F4" d="M37 0H5a5 5 0 0 0-5 5v6h11V0h26Z" />
      <path fill="#188038" d="M0 37v6a5 5 0 0 0 5 5h6V37H0Z" />
      <path fill="#FBBC04" d="M0 11h11v26H0z" />
      <path fill="#34A853" d="M11 37v11h26V37H11Z" />
      <path fill="#1967D2" d="M48 11H37v26h11V11Z" />
      <path
        fill="#4285F4"
        d="M17.24 30.6a3.9 3.9 0 0 1-1.6-2.31l2.26-.93q.19.72.67 1.12c.31.26.7.39 1.15.39q.7 0 1.17-.42c.32-.28.48-.64.48-1.08q0-.67-.5-1.09c-.34-.28-.76-.42-1.26-.42h-1.3v-2.23h1.17q.65 0 1.1-.35c.3-.24.44-.56.44-.97q0-.55-.4-.87a1.5 1.5 0 0 0-1.01-.33 1.4 1.4 0 0 0-1.42 1.03l-2.24-.93q.29-.83 1.12-1.47.85-.63 2.15-.63 .97 0 1.74.37.78.37 1.22 1.03.44.66.44 1.48 0 .84-.4 1.42-.4.58-.99.89v.13q.78.33 1.27.98.5.66.5 1.57 0 .91-.46 1.63-.46.71-1.28 1.12-.82.41-1.85.41-1.19 0-2.2-.68Zm10.87-8.05-2.48 1.8-1.24-1.88 4.45-3.21h1.71v11.9h-2.44v-8.61Z"
      />
    </svg>
  );
}
