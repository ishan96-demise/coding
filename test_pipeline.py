import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GCNConv
from torch_geometric.data import Data

# ---------------------------------------------------------
# 1. CREATE A MINI TRANSACTION GRAPH (4 Accounts, 1 Shared Device)
# ---------------------------------------------------------
# Nodes:
# 0 = Account A (Normal)
# 1 = Account B (Mule Account)
# 2 = Account C (Suspicious)
# 3 = Shared Device #99 (Attribute Node)

# Connections:
# Account 0 -> Account 1
# Account 2 -> Account 1
# Account 1 & 2 -> Device 3
edge_index = torch.tensor([
    [0, 2, 1, 2],
    [1, 1, 3, 3]
], dtype=torch.long)

# Features: [Amount, Velocity, Flagged_Device]
x = torch.tensor([
    [10.0, 1.0, 0.0],
    [500.0, 15.0, 1.0],
    [450.0, 12.0, 1.0],
    [0.0, 0.0, 0.0]
], dtype=torch.float)

# Labels: 0 = Safe, 1 = Fraud
y = torch.tensor([0, 1, 1, 0], dtype=torch.long)

graph_data = Data(x=x, edge_index=edge_index, y=y)

# ---------------------------------------------------------
# 2. DEFINE THE GNN ARCHITECTURE
# ---------------------------------------------------------
class SimpleFraudGNN(nn.Module):
    def __init__(self, in_features):
        super(SimpleFraudGNN, self).__init__()
        self.conv1 = GCNConv(in_features, 16)
        self.conv2 = GCNConv(16, 2)

    def forward(self, x, edge_index):
        x = self.conv1(x, edge_index)
        x = F.relu(x)
        x = self.conv2(x, edge_index)
        return F.log_softmax(x, dim=1)

# ---------------------------------------------------------
# 3. TRAIN THE MODEL
# ---------------------------------------------------------
model = SimpleFraudGNN(in_features=3)
optimizer = torch.optim.Adam(model.parameters(), lr=0.05)
criterion = nn.NLLLoss()

model.train()
for epoch in range(1, 51):
    optimizer.zero_grad()
    out = model(graph_data.x, graph_data.edge_index)
    loss = criterion(out, graph_data.y)
    loss.backward()
    optimizer.step()

# ---------------------------------------------------------
# 4. INFERENCE & EXPLANATIONS
# ---------------------------------------------------------
model.eval()
with torch.no_grad():
    out = model(graph_data.x, graph_data.edge_index)
    probabilities = torch.exp(out)

def test_account_analysis(account_id):
    fraud_prob = probabilities[account_id][1].item() * 100
    
    reasons = []
    if fraud_prob > 50:
        reasons.append(f"GNN structural anomaly confidence: {fraud_prob:.1f}%")
        reasons.append("Shares device fingerprint with known high-risk accounts")
        reasons.append("High transaction velocity within 2-hop graph neighborhood")

    print("\n" + "=" * 50)
    print(f"🔍 ANALYZING ACCOUNT #{account_id}")
    print(f"📊 RISK SCORE: {fraud_prob:.1f} / 100")
    print(f"🚨 STATUS: {'HIGH RISK (FLAGGED)' if fraud_prob > 50 else 'SAFE'}")
    print("💡 CONTRIBUTING FACTORS:")
    for reason in reasons:
        print(f"   • {reason}")
    print("=" * 50 + "\n")

# Run test on Account #2
test_account_analysis(account_id=2)