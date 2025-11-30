
import { Router } from "express";
import { getServices, getCoaches, getHolidays } from "../controllers/meta.controller.js";
const r = Router();
r.get("/services", getServices);
r.get("/coaches", getCoaches);
r.get("/holidays", getHolidays);
export default r;
