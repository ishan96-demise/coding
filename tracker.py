def calculate_wealth(monthly, interest_rate, duration):
    total = 0
    monthly_rate = (interest_rate / 100) / 12
    months = duration * 12

    for m in range(1, months + 1):
        total = (total + monthly) * (1 + monthly_rate)
    return round(total, 2)

name = "Ishan Tripathi"
print(f"--- {name}'s Future Capital ---")

# Execute Mission
investment = 5000
growth_rate = 12
time_period = 10

final_amount = calculate_wealth(investment, growth_rate, time_period)

print(f"If you invest {investment} monthly for {time_period} years...")
print(f"Your final stack will be: {final_amount}")