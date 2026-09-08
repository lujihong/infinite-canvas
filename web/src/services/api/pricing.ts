import { apiGet } from "./request";

export type ModelPricingItem = {
    model_name: string;
    quota_type: number; // 0: 按Token计费, 1: 按次计费
    model_price: number;
    model_ratio: number;
    completion_ratio: number;
    points_cost: number;
    formatted_points_cost: string;
    billing_description: string;
    supported_endpoint_types: string[];
};

export async function fetchModelPricingList() {
    return apiGet<ModelPricingItem[]>("/api/model-pricing");
}
