import knex, { migrate, seed } from "#postgres/knex.js";
import { z } from "zod";
import env from "./config/env/env.js";
import { google } from "googleapis";
import { CronJob } from "cron";

await migrate.latest();
await seed.run();

console.log("All migrations and seeds have been run");

const WarehouseTarrif = z.object({
    boxDeliveryAndStorageExpr: z.string(),
    boxDeliveryBase: z.string(),
    boxDeliveryLiter: z.string(),
    boxStorageBase: z.string(),
    boxStorageLiter: z.string(),
    warehouseName: z.string(),
});

type WarehouseTarrif = z.infer<typeof WarehouseTarrif>;

type BoxTarrifsResponce = {
    response: {
        data: {
            dtNextBox: string;
            dtTillMax: string;
            warehouseList: WarehouseTarrif[];
        };
    };
};

const fetchTarrifs = async () => {
    const res = await fetch("https://common-api.wildberries.ru/api/v1/tariffs/box?date=2025-06-17", {
        headers: {
            "Authorization": env.WB_TOKEN,
        },
    });
    if (!res.ok) {
        throw new Error(res.statusText);
    }
    const resBody: BoxTarrifsResponce = await res.json();
    return resBody.response.data.warehouseList;
};

const upsertTarrifs = async (tarrifs: WarehouseTarrif[]) => {
    const [date, lastUpdate] = new Date().toISOString().split("T");
    const records = tarrifs.map((tarrif) => ({ date, lastUpdate, ...tarrif }));
    await knex("wb_box_tariffs").insert(records).onConflict(["date", "warehouseName"]).merge();
};

const updateSheets = async () => {
    const auth = new google.auth.GoogleAuth({
        keyFile: env.GOOGLE_SERVICE_ACCOUNT,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const idList = (await knex.select("*").from("spreadsheets")).map((row) => row["spreadsheet_id"]);
    const tariffs = (await knex.select("*").orderBy('boxDeliveryAndStorageExpr').from("wb_box_tariffs")).map((row) => Object.values(row));
    idList.forEach(
        async (spreadsheetId) =>
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `stocks_coefs!A1:H${tariffs.length}`,
                valueInputOption: "RAW",
                requestBody: {
                    range: `stocks_coefs!A1:H${tariffs.length}`,
                    majorDimension: "ROWS",
                    values: tariffs,
                },
            }),
    );
};

const job = new CronJob(
    "0 0 * * * *", // cronTime
    async function () {
        const tariffs = await fetchTarrifs();
        await upsertTarrifs(tariffs);
        await updateSheets();
    }, // onTick
    null, // onComplete
    true, // start
    "Europe/Moscow", // timeZone
);
