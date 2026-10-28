import mongoose from "mongoose";

// One coordination document per date/time, shared by all booking entry points.
// No client data and no expiry: deleting an active lock could break serialization.
const schema = new mongoose.Schema({
  _id: {type: String, required: true},
  revision: {type: Number, default: 0}
}, {versionKey: false});
export default mongoose.models.BookingSlotLock || mongoose.model("BookingSlotLock", schema);
