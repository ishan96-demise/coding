export type Transaction = {
  transaction_id: string;
  source_account: string;
  target_account: string;
  source_name?: string | null;
  target_name?: string | null;
  amount: number;
  currency?: string;
  amount_inr?: number | null;
  instructed_amount?: number | null;
  instructed_currency?: string | null;
  fx_divergence_ratio?: number | null;
  fx_reference_rate?: number | null;
  fx_rate_as_of?: string | null;
  fx_rate_source?: string | null;
  currency_mismatch?: boolean;
  source_provider?: string | null;
  source_event_id?: string | null;
  fx_unconverted?: boolean;
  direction?: "OUTGOING" | "INCOMING" | string;
  timestamp: string;
  device_id?: string | null;
  ip_address?: string | null;
  location?: string | null;
  location_country?: string | null;
  source_country?: string | null;
  target_country?: string | null;
};

export type IntelligenceSnapshot = {
  network_risk_score: number;
  peak_cohort_risk_score?: number;
  network_status: string;
  network_score_method?: string;
  account_count: number;
  transaction_count: number;
  high_risk_network_accounts?: number;
  watch_network_accounts?: number;
  priority_accounts?: {
    account_id: string;
    risk_score: number;
    status: string;
    reasons?: string[];
    cycle_count?: number;
    mule_account?: boolean;
  }[];
  shared_device_count: number;
  shared_ip_count: number;
  observed_countries: string[];
  observed_routes?: string[];
  last_updated?: string;
  last_transaction_at?: string | null;
  data_mode?: "demo" | "production";
  source_mode?: string;
};

export type NetworkNode = {
  id: string;
  label: string;
  type: "account" | "device" | "ip_address" | "merchant" | "location" | string;
  connection_count: number;
  shared_account_count: number;
  is_shared: boolean;
};

export type NetworkEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  amount?: number;
  currency?: string;
  amount_inr?: number | null;
  total_amount_inr?: number | null;
  currency_mismatch?: boolean;
  fx_divergence_ratio?: number | null;
  timestamp?: string | null;
  first_timestamp?: string | null;
  last_timestamp?: string | null;
  transaction_id?: string | null;
  total_amount?: number;
  max_amount?: number;
  transaction_count?: number;
  transaction_ids?: string[];
  evidence_source?: string;
  device_id?: string | null;
  ip_address?: string | null;
  merchant_id?: string | null;
  location?: string | null;
  location_country?: string | null;
  source_country?: string | null;
  target_country?: string | null;
};

export type NetworkGraphData = {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
};

export type AccountFlowMetrics = {
  inbound: number;
  outbound: number;
  total: number;
  pass_through_ratio: number;
  retention_ratio: number;
  velocity_window_count: number;
};

export type AccountRiskSignal = {
  account_id: string;
  risk_score: number;
  account_risk_score?: number;
  network_risk_score?: number;
  status: string;
  mule_account: boolean;
  in_fraud_ring: boolean;
  cycle_count: number;
  flow_metrics?: AccountFlowMetrics;
  gnn?: {
    available?: boolean;
    score?: number | null;
    confidence?: number;
    confidence_label?: string;
    confidence_basis?: string;
    confidence_is_probability?: boolean;
  };
};

export type AgentWidget = {
  event_id: string;
  agent: string;
  widget_type: "risk-score" | "evidence-list" | string;
  subject: string;
  score: number;
  risk_level: string;
  confidence: number | null;
  confidence_label?: string;
  rationale: string;
  evidence: string[];
  score_components?: Record<string, Record<string, number | boolean>>;
  timestamp: string;
};
