
import { db } from "../models/store.js";
export const getServices = (req,res)=> res.json(db.services);
export const getCoaches = (req,res)=> res.json(db.coaches);
export const getHolidays = (req,res)=> res.json(db.holidaysAR);
