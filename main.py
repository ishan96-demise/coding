from fastapi import FastAPI

app = FastAPI()

@app.get("/calculate")
def get_wealth(monthly: float, interest_rate: float, duration: int):
    total = 0
    monthly_rate = (interest_rate / 100) / 12
    months = duration * 12

    for m in range(1, months + 1):
        total = (total + monthly) * (1 + monthly_rate)
        
    return {
        "status": "success",
        "monthly_investment": monthly,
        "years": duration,
        "final_stack": round(total, 2)
    }