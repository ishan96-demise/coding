import type { Metadata } from "next";
import { CustomerSettings } from "@/components/customer-settings";

export const metadata: Metadata = { title: "Settings | Fin Sentinels", description: "Manage your Fin Sentinels customer profile, password, and linked sample accounts." };

export default function SettingsPage() { return <CustomerSettings />; }
