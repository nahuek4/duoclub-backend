// backend/src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, default: "" },
    dni: { type: String, default: "" },
    age: { type: Number, default: null },
    weight: { type: Number, default: null },
    notes: { type: String, default: "" },

    credits: { type: Number, default: 0 },
    role: { type: String, default: "client" }, // "admin" | "client"

    password: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" }, // "uploaded" | "approved" | "rejected"
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

const User = mongoose.model("User", userSchema);
export default User;
