"use client";

import { useState, type FormEvent } from "react";
import { Check, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { PortalShell, usePortal } from "@/components/portal-shell";

function SettingsContent() {
  const { user, accounts, reload } = usePortal();
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setProfileBusy(true); setError(""); setSuccess("");
    try {
      const response = await fetch("/api/portal/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Profile changes could not be saved.");
      await reload(); setSuccess("Your profile has been updated.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Profile changes could not be saved."); }
    finally { setProfileBusy(false); }
  };

  const updatePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPasswordBusy(true); setError(""); setSuccess("");
    if (newPassword.length < 10) { setError("Use at least 10 characters for the new password."); setPasswordBusy(false); return; }
    try {
      const response = await fetch("/api/portal/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }), cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Your password could not be changed.");
      setCurrentPassword(""); setNewPassword(""); setSuccess("Your password has been changed. Other sessions were signed out.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Your password could not be changed."); }
    finally { setPasswordBusy(false); }
  };

  return <>
    <div className="settings-grid">
      <section className="settings-card"><div className="settings-card-heading"><span className="step-icon"><UserRound size={19}/></span><div><h2>Profile</h2><p>Update the name shown in your workspace.</p></div></div><form className="settings-form" onSubmit={saveProfile}><label>Name<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={100} required /></label><label>Email address<input value={user.email} readOnly aria-readonly="true"/><span className="form-hint">Email changes are not available in this preview.</span></label><button className="button button-primary" type="submit" disabled={profileBusy}>{profileBusy ? <><LoaderCircle size={16} className="spin"/> Saving…</> : "Save profile"}</button></form></section>
      <section className="settings-card"><div className="settings-card-heading"><span className="step-icon"><LockKeyhole size={19}/></span><div><h2>Password</h2><p>Choose a new password for this customer login.</p></div></div><form className="settings-form" onSubmit={updatePassword}><label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>New password<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={10} maxLength={128} required /><span className="form-hint">Use at least 10 characters.</span></label><button className="button button-outline" type="submit" disabled={passwordBusy}>{passwordBusy ? <><LoaderCircle size={16} className="spin"/> Updating…</> : "Change password"}</button></form></section>
      <section className="settings-card linked-accounts-card"><div className="settings-card-heading"><span className="step-icon"><Check size={19}/></span><div><h2>Linked sample accounts</h2><p>Only these synthetic accounts are available to your login.</p></div></div><ul className="linked-account-list">{accounts.map((account) => <li key={account.account_id}><span><strong>{account.name}</strong><small>{account.account_id}</small></span><span className="synthetic-label">Synthetic</span></li>)}</ul></section>
    </div>
    {error && <p role="alert" className="form-error settings-feedback">{error}</p>}{success && <p role="status" className="report-success settings-feedback"><Check size={18}/>{success}</p>}
    <p className="portal-demo-note">This demo does not support email verification, password recovery, account deletion, or linking a real bank account.</p>
  </>;
}

export function CustomerSettings() {
  return <PortalShell active="settings" title="Settings" subtitle="Manage your customer profile, password, and linked sample accounts."><SettingsContent /></PortalShell>;
}
