/**
 *
 * In-market Audiences Bidding
 *
 * Automatically apply modifiers to your in-market audiences based on performance.
 *
 * Version: 1.0
 * Google AdWords Script maintained on brainlabsdigital.com
 *
 * */

// Use this to determine the relevant date range for your data.
// See here for the possible options:
// https://developers.google.com/google-ads/scripts/docs/reference/adwordsapp/adwordsapp_campaignselector#forDateRange_1
const DATE_RANGE = 'LAST_7_DAYS';

// Use this to determine the minimum number of impressions a campaign or
// and ad group should have before being considered.
const MINIMUM_IMPRESSIONS = 50;

// Use this if you want to exclude some campaigns. Case insensitive.
// For example ["Brand"] would ignore any campaigns with 'brand' in the name,
// while ["Brand","Competitor"] would ignore any campaigns with 'brand' or
// 'competitor' in the name.
// Leave as [] to not exclude any campaigns.
const CAMPAIGN_NAME_DOES_NOT_CONTAIN = [];

// Use this if you only want to look at some campaigns.  Case insensitive.
// For example ["Brand"] would only look at campaigns with 'brand' in the name,
// while ["Brand","Generic"] would only look at campaigns with 'brand' or 'generic'
// in the name.
// Leave as [] to include all campaigns.
const CAMPAIGN_NAME_CONTAINS = ['_Search_'];

const AUDIENCE_MAPPING_CSV_DOWNLOAD_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRlOLrAYX4Sdw_qR5kdRpI1lyeXB0QXRtS0s0alHqEzNXxAeauuTshs1Z21S4Fk8xBNJrkR_ps5VlX/pub?gid=0&single=true&output=csv';

function main() {
  Logger.log('Getting audience mapping');
  const audienceMapping = getInMarketAudienceMapping(
    AUDIENCE_MAPPING_CSV_DOWNLOAD_URL,
  );

  Logger.log('Getting campaign performance');
  const campaignPerformance = getCampaignPerformance();

  Logger.log('Getting ad group performance');
  const adGroupPerformance = getAdGroupPerformance();

  Logger.log('Making operations');
  const operations = makeAllOperations(
    audienceMapping,
    campaignPerformance,
    adGroupPerformance,
  );

  Logger.log('Applying bids');
  applyBids(operations);
}

function getInMarketAudienceMapping(downloadCsvUrl) {
  const csv = Utilities.parseCsv(
    UrlFetchApp.fetch(downloadCsvUrl).getContentText(),
  );

  const headers = csv[0];
  const indexOfId = headers.indexOf('Criterion ID');
  const indexOfName = headers.indexOf('Category');

  if (indexOfId === -1 || indexOfName === -1) {
    throw new Error('The audience CSV does not have the expected headers');
  }

  const mapping = {};
  for (let i = 1; i < csv.length; i++) {
    const row = csv[i];
    mapping[row[indexOfId]] = row[indexOfName];
  }

  return mapping;
}

function getCampaignPerformance() {
  return getEntityPerformance('CampaignId', 'CAMPAIGN_PERFORMANCE_REPORT');
}

function getAdGroupPerformance() {
  return getEntityPerformance('AdGroupId', 'ADGROUP_PERFORMANCE_REPORT');
}

function getEntityPerformance(entityIdFieldName, reportName) {
  const performance = {};
  const query = `SELECT ${entityIdFieldName}, CostPerAllConversion `
    + `FROM ${reportName} `
    + `WHERE Impressions > ${String(MINIMUM_IMPRESSIONS)} `
    + `DURING ${DATE_RANGE}`;
  const rows = AdsApp.report(query).rows();

  while (rows.hasNext()) {
    const row = rows.next();
    performance[row[entityIdFieldName]] = row.CostPerAllConversion;
  }
  return performance;
}

function makeAllOperations(
  audienceMapping,
  campaignPerformance,
  adGroupPerformance,
) {
  let operations = [];

  const allCampaigns = filterCampaignsBasedOnName(AdWordsApp.campaigns());

  const filteredCampaigns = filterEntitiesBasedOnDateAndImpressions(
    allCampaigns,
  ).get();

  while (filteredCampaigns.hasNext()) {
    const campaign = filteredCampaigns.next();

    // Can't have both ad-group-level and campaign-level
    // audiences on any given campaign.
    if (campaignHasAnyCampaignLevelAudiences(campaign)) {
      const operationsFromCampaign = makeOperationsFromEntity(
        campaign,
        campaignPerformance[campaign.getId()],
        audienceMapping,
      );

      operations = operations.concat(operationsFromCampaign);
    } else {
      const adGroups = filterEntitiesBasedOnDateAndImpressions(
        campaign.adGroups(),
      ).get();

      while (adGroups.hasNext()) {
        const adGroup = adGroups.next();
        const operationsFromAdGroup = makeOperationsFromEntity(
          adGroup,
          adGroupPerformance[adGroup.getId()],
          audienceMapping,
        );

        operations = operations.concat(operationsFromAdGroup);
      }
    }
  }

  return operations;
}

function filterCampaignsBasedOnName(campaigns) {
  CAMPAIGN_NAME_DOES_NOT_CONTAIN.forEach((part) => {
    campaigns = campaigns.withCondition(
      `CampaignName DOES_NOT_CONTAIN_IGNORE_CASE '${part.replace(/"/g, '\\"')}'`,
    );
  });

  CAMPAIGN_NAME_CONTAINS.forEach((part) => {
    campaigns = campaigns.withCondition(
      `CampaignName CONTAINS_IGNORE_CASE '${part.replace(/"/g, '\\"')}'`,
    );
  });

  return campaigns;
}

function filterEntitiesBasedOnDateAndImpressions(selector) {
  return selector
    .forDateRange(DATE_RANGE)
    .withCondition(`Impressions > ${String(MINIMUM_IMPRESSIONS)}`);
}

function makeOperationsFromEntity(entity, entityCpa, audienceMapping) {
  const entityAudiences = getAudiencesFromEntity(entity, audienceMapping);
  return makeOperations(entityCpa, entityAudiences);
}

function getAudiencesFromEntity(entity, audienceMapping) {
  const inMarketIds = Object.keys(audienceMapping);

  const allAudiences = entity
    .targeting()
    .audiences()
    .forDateRange(DATE_RANGE)
    .withCondition(`Impressions > ${String(MINIMUM_IMPRESSIONS)}`)
    .get();

  const inMarketAudiences = [];
  while (allAudiences.hasNext()) {
    const audience = allAudiences.next();
    if (isAudienceInMarketAudience(audience, inMarketIds)) {
      inMarketAudiences.push(audience);
    }
  }

  return inMarketAudiences;
}

function isAudienceInMarketAudience(audience, inMarketIds) {
  return inMarketIds.indexOf(audience.getAudienceId()) > -1;
}

function makeOperations(entityCpa, audiences) {
  const operations = [];
  audiences.forEach((audience) => {
    const stats = audience.getStatsFor(DATE_RANGE);
    const conversions = stats.getConversions();
    if (conversions > 0) {
      const audienceCpa = stats.getCost() / stats.getConversions();
      entityCpa = parseFloat(entityCpa);
      const modifier = entityCpa / audienceCpa;

      const operation = {};
      operation.audience = audience;
      operation.modifier = modifier;

      operations.push(operation);
    }
  });

  return operations;
}

function campaignHasAnyCampaignLevelAudiences(campaign) {
  const totalNumEntities = campaign
    .targeting()
    .audiences()
    .get()
    .totalNumEntities();

  return totalNumEntities > 0;
}

function applyBids(operations) {
  operations.forEach((operation) => {
    operation.audience.bidding().setBidModifier(operation.modifier);
  });
}
