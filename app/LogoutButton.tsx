"use client";

export default function LogoutButton() {
  return (
    <button
      className="button"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.assign("/login");
      }}
    >
      Sign out
    </button>
  );
}
