import 'dotenv/config';
import mongoose from 'mongoose';

if (!process.env.MONGO_URI) throw new Error('Falta MONGO_URI en la configuración del backend.');
await mongoose.connect(process.env.MONGO_URI, {autoIndex:false, autoCreate:false});
try {
  const users = mongoose.connection.collection('users');
  const duplicates = await users.aggregate([
    {$match:{email:{$type:'string', $gt:''}}},
    {$group:{_id:{$toLower:{$trim:{input:'$email'}}}, count:{$sum:1}}},
    {$match:{count:{$gt:1}}},
    {$count:'groups'}
  ]).toArray();
  const count = duplicates[0]?.groups || 0;
  console.log(`Grupos de emails duplicados: ${count}. No se borró ni modificó ningún usuario.`);
  if (count) {
    console.error('Resolver los duplicados con revisión del administrador antes de cargar más usuarios. No crear el índice todavía.');
    process.exitCode = 1;
  } else {
    let indexes=[];
    try {indexes=await users.indexes();} catch (e) {if(e.codeName!=='NamespaceNotFound')throw e;}
    const unique=indexes.some(x=>x.unique && x.key.email===1 && Object.keys(x.key).length===1);
    if(unique) console.log('Ya existe un índice único de email; se conserva.');
    else if(process.argv.includes('--apply')) {
      await users.createIndex({email:1},{name:'email_1', unique:true, partialFilterExpression:{email:{$type:'string',$gt:''}}});
      console.log('Índice único de email creado.');
    } else console.log('Falta el índice único de email. Ejecutar con --apply después de revisar este resultado.');
  }
} finally {await mongoose.disconnect();}
