use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndustryNiche {
    RealEstate,
    Healthcare,
    Logistics,
    CustomB2B,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionTier {
    Starter,
    Professional,
    Enterprise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantProfile {
    pub id: String,
    pub name: String,
    pub niche: IndustryNiche,
    pub tier: SubscriptionTier,
    pub max_rpm: u32,
    pub active: bool,
}
